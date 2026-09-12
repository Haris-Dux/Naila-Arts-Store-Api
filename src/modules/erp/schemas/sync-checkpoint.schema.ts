import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SyncCheckpointDocument = HydratedDocument<SyncCheckpoint>;

/**
 * Where the change stream had got to.
 *
 * Persisted so a restart resumes instead of replaying the oplog from the start
 * or, worse, silently skipping everything that happened while the process was
 * down. One document, keyed by stream name.
 *
 * A resume token is only usable while the events it points at are still in the
 * oplog. Past that window MongoDB reports `ChangeStreamHistoryLost`, which is
 * the signal to fall back to a full reconciliation rather than to carry on and
 * quietly serve stale stock.
 */
@Schema({ timestamps: true, collection: 'erp_sync_checkpoints' })
export class SyncCheckpoint {
  /** Stream identifier, e.g. `suits-stock`. */
  @Prop({ required: true, unique: true })
  name!: string;

  /** Opaque MongoDB resume token. */
  @Prop({ type: Object, required: true })
  token!: Record<string, unknown>;

  updatedAt!: Date;
}

export const SyncCheckpointSchema = SchemaFactory.createForClass(SyncCheckpoint);
