import { NotificationKind } from './template.service';

/** The payload of a queued notification job. */
export interface NotificationJob {
  kind: NotificationKind;
  /** Makes repeat delivery of the same event a no-op. */
  dedupeKey: string;
  recipient: string;
  recipientName: string;
  userId: string | null;
  locale?: string;
  /** Template context — already formatted for display. */
  data: Record<string, unknown>;
}

export const NOTIFICATION_JOB = 'send-notification';
