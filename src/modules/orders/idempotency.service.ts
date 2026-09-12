import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { ConflictException } from '../../common/exceptions/domain.exception';
import {
  IdempotencyKey,
  IdempotencyKeyDocument,
  IdempotencyState,
} from './schemas/idempotency-key.schema';

export interface IdempotencyClaim {
  /** The stored response, when this key has already been completed. */
  replay?: Record<string, unknown>;
  /** Present when this caller won the race and should do the work. */
  token?: Types.ObjectId;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectModel(IdempotencyKey.name)
    private readonly keyModel: Model<IdempotencyKeyDocument>,
  ) {}

  static fingerprint(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  /**
   * Attempt to claim a key.
   *
   * Returns a `token` when this caller should proceed, or a `replay` when the
   * work has already been done. Two concurrent requests with the same key cannot
   * both receive a token: the unique index rejects the second insert.
   */
  async claim(
    key: string,
    ownerScope: string,
    endpoint: string,
    body: unknown,
    userId?: string | null,
  ): Promise<IdempotencyClaim> {
    // Scoped by caller *and* route, so two customers — or two guests — cannot
    // collide on a shared key value like "checkout-1".
    const scoped = `${ownerScope}:${endpoint}:${key}`;
    const fingerprint = IdempotencyService.fingerprint(body);

    try {
      const created = await this.keyModel.create({
        key: scoped,
        userId: userId ? new Types.ObjectId(userId) : null,
        endpoint,
        state: IdempotencyState.IN_PROGRESS,
        requestFingerprint: fingerprint,
      });
      return { token: created._id };
    } catch (error) {
      if (!this.isDuplicateKey(error)) throw error;
    }

    const existing = await this.keyModel.findOne({ key: scoped }).exec();
    // Expired between the failed insert and this read; let the caller retry
    // rather than inventing a result.
    if (!existing) throw new ConflictException('Please retry this request');

    // Same key, different body: the client has reused a key for a different
    // request. Replaying the first response would hide a real bug.
    if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different request body',
      );
    }

    if (existing.state === IdempotencyState.COMPLETED && existing.response) {
      this.logger.log(`Replaying idempotent response for ${endpoint} key ${key}`);
      return { replay: existing.response };
    }

    // Still running. 409 rather than a second execution — the client should wait
    // and retry, at which point it will get the stored response.
    throw new ConflictException('A request with this Idempotency-Key is still in progress');
  }

  /** Store the outcome so any later replay returns it verbatim. */
  async complete(
    token: Types.ObjectId,
    response: Record<string, unknown>,
    resourceId?: Types.ObjectId,
  ): Promise<void> {
    await this.keyModel
      .updateOne(
        { _id: token },
        {
          $set: {
            state: IdempotencyState.COMPLETED,
            response,
            resourceId: resourceId ?? null,
          },
        },
      )
      .exec();
  }

  /**
   * Drop the key after a failed attempt, so the client can retry.
   *
   * Leaving it IN_PROGRESS would lock the customer out of checking out with that
   * key until the 24h TTL expired.
   */
  async release(token: Types.ObjectId): Promise<void> {
    await this.keyModel.deleteOne({ _id: token, state: IdempotencyState.IN_PROGRESS }).exec();
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
