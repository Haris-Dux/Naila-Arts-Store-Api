import { NotificationsService } from './notifications.service';

/**
 * A unit test rather than an e2e one, deliberately.
 *
 * The e2e suite delivers notifications inline so it needs no Redis, which means
 * it never exercises the BullMQ hop — and that is exactly where this bug lived:
 * BullMQ rejected every job id because the dedupe key contained a colon, so no
 * email was ever sent in a real deployment while every test passed. Asserting
 * the constraint directly closes that gap without dragging Redis into the suite.
 */
describe('NotificationsService.toJobId', () => {
  it('strips colons, which BullMQ reserves as its key separator', () => {
    expect(NotificationsService.toJobId('orderPlaced:507f1f77bcf86cd799439011')).toBe(
      'orderPlaced-507f1f77bcf86cd799439011',
    );
  });

  it('produces an id containing no colon for every notification kind', () => {
    const keys = [
      'orderPlaced:507f1f77bcf86cd799439011',
      'orderPaid:507f1f77bcf86cd799439011',
      'shipmentDispatched:507f1f77bcf86cd799439011',
    ];

    for (const key of keys) {
      expect(NotificationsService.toJobId(key)).not.toContain(':');
    }
  });

  it('stays unique across kinds for the same aggregate', () => {
    const placed = NotificationsService.toJobId('orderPlaced:abc');
    const paid = NotificationsService.toJobId('orderPaid:abc');
    expect(placed).not.toBe(paid);
  });
});
