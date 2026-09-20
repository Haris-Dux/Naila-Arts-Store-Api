import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SignOptions } from 'jsonwebtoken';
import { Model, Types } from 'mongoose';
import { parseDuration } from '../../common/duration';
import { AuthenticationException } from '../../common/exceptions/domain.exception';
import { UserDocument } from '../users/schemas/user.schema';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';
import { AccessTokenPayload, TokenPair } from './types/token-payload';

export interface ClientContext {
  userAgent?: string | null;
  ip?: string | null;
}

@Injectable()
export class TokenService {
  private readonly accessTtl: string;
  private readonly refreshTtlMs: number;

  constructor(
    @InjectModel(RefreshToken.name)
    private readonly refreshTokenModel: Model<RefreshTokenDocument>,
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.accessTtl = config.getOrThrow<string>('auth.accessTokenTtl');
    this.refreshTtlMs = parseDuration(config.getOrThrow<string>('auth.refreshTokenTtl'));
  }

  /**
   * Refresh tokens are opaque random strings, not JWTs: they carry no claims, so
   * a leaked one reveals nothing, and they can be revoked individually because
   * their digest is a database row.
   */
  private static generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Only the digest is ever persisted, so a database dump yields no usable session. */
  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Mint a fresh access + refresh pair, starting a new token family. */
  async issuePair(user: UserDocument, client: ClientContext = {}): Promise<TokenPair> {
    return this.issue(user, randomUUID(), client);
  }

  private async issue(
    user: UserDocument,
    family: string,
    client: ClientContext,
  ): Promise<TokenPair> {
    const payload: AccessTokenPayload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: this.accessTtl as SignOptions['expiresIn'],
    });

    const refreshToken = TokenService.generateRefreshToken();
    await this.refreshTokenModel.create({
      userId: user._id,
      tokenHash: TokenService.hash(refreshToken),
      family,
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
      userAgent: client.userAgent ?? null,
      ip: client.ip ?? null,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(parseDuration(this.accessTtl) / 1000),
      tokenType: 'Bearer',
    };
  }

  /**
   * Validate a presented refresh token and consume it.
   *
   * Rotation with reuse detection: a token is single-use, and presenting one
   * that has already been rotated means it leaked — the legitimate holder and
   * the attacker cannot both have it. In that case the entire family is revoked,
   * forcing a real re-login rather than letting a thief ride the chain.
   *
   * **The consume is the first thing that happens, and it is atomic.** This used
   * to read the record, check `revokedAt`, resolve the user, and only then write
   * the revocation — three round trips between the check and the act. Two
   * parallel refreshes with the same stolen token both observed `revokedAt:
   * null`, both passed, and both issued: two live tokens in one family and the
   * reuse branch never fired, which is precisely the attack rotation exists to
   * stop. Claiming the row in the filter makes the check and the consume one
   * operation, so exactly one caller can ever win.
   */
  async consumeAndRotate(
    presented: string,
    resolveUser: (userId: string) => Promise<UserDocument | null>,
    client: ClientContext = {},
  ): Promise<TokenPair> {
    const tokenHash = TokenService.hash(presented);

    const record = await this.refreshTokenModel
      .findOneAndUpdate(
        { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { revokedAt: new Date(), revokedReason: 'rotated' } },
        { new: true },
      )
      .exec();

    if (!record) {
      // Nothing was claimed. Re-read to tell the three reasons apart, because
      // they are not equally serious: an unknown token is noise, an expired one
      // is routine, but a token that was already consumed means it leaked — or
      // that the legitimate client fired two refreshes at once. Revoking the
      // family is the safe response to both.
      const existing = await this.refreshTokenModel.findOne({ tokenHash }).exec();

      if (!existing) throw new AuthenticationException('Invalid refresh token');

      if (existing.revokedAt) {
        await this.revokeFamily(existing.family, 'reuse-detected');
        throw new AuthenticationException('Refresh token has already been used');
      }

      throw new AuthenticationException('Refresh token has expired');
    }

    const user = await resolveUser(record.userId.toString());
    if (!user) {
      // The token is already spent, so the family revocation is what stops the
      // rest of the chain being usable.
      await this.revokeFamily(record.family, 'user-unavailable');
      throw new AuthenticationException('Account is no longer active');
    }

    return this.issue(user, record.family, client);
  }

  /** Revoke a single presented token — an ordinary logout. */
  async revokeToken(presented: string): Promise<void> {
    await this.refreshTokenModel
      .updateOne(
        { tokenHash: TokenService.hash(presented), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
      )
      .exec();
  }

  async revokeFamily(family: string, reason: string): Promise<void> {
    await this.refreshTokenModel
      .updateMany(
        { family, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
      )
      .exec();
  }

  /** Revoke every live session — logout everywhere, password change, deactivation. */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.refreshTokenModel
      .updateMany(
        { userId: new Types.ObjectId(userId), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
      )
      .exec();
    return result.modifiedCount;
  }
}
