/**
 * One-off: rename the order status REFUNDED to RETURNED.
 *
 * REFUNDED used to mean two different things — the money went back, and the
 * goods came back — and the order state machine no longer models money at all.
 * A refund is now recorded against the payment and settled by a person; the
 * order records only whether the goods returned.
 *
 *   MONGO_URI="mongodb://…/naila_dev?…" node scripts/migrate-refunded-to-returned.js --dry-run
 *   MONGO_URI="mongodb://…/naila_dev?…" node scripts/migrate-refunded-to-returned.js
 *
 * `--dry-run` counts what would change and writes nothing.
 *
 * This must run, not merely should: the dashboard looks a status up in a
 * transitions table, and an order left on REFUNDED resolves to `undefined`
 * there and throws when its detail screen is opened. Mongoose also rejects the
 * value on any later write, because it is no longer in the schema's enum.
 *
 * Three things move together:
 *   - `status` on the order itself
 *   - every `statusHistory[].status` entry, so the timeline stays readable
 *   - `refundedAt` becomes `returnedAt`
 *
 * Safe to run more than once: a second run finds nothing left to rename.
 */
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGO_URI to the database to migrate.');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const orders = db.collection('orders');

    const byStatus = { status: 'REFUNDED' };
    // History is migrated independently of the current status: an order that
    // was refunded and is now something else still has the old word in its
    // timeline.
    const byHistory = { 'statusHistory.status': 'REFUNDED' };
    const byTimestamp = { refundedAt: { $exists: true } };

    const [statusCount, historyCount, timestampCount] = await Promise.all([
      orders.countDocuments(byStatus),
      orders.countDocuments(byHistory),
      orders.countDocuments(byTimestamp),
    ]);

    console.log(`Database: ${db.databaseName}`);
    console.log(`Orders currently REFUNDED: ${statusCount}`);
    console.log(`Orders with REFUNDED in their history: ${historyCount}`);
    console.log(`Orders carrying refundedAt: ${timestampCount}`);

    if (dryRun) {
      console.log('Dry run — nothing written.');
      return;
    }

    const status = await orders.updateMany(byStatus, { $set: { status: 'RETURNED' } });

    // Positional-filtered update: rewrites every matching history entry, not
    // just the first, which `$` alone would do.
    const history = await orders.updateMany(
      byHistory,
      { $set: { 'statusHistory.$[entry].status': 'RETURNED' } },
      { arrayFilters: [{ 'entry.status': 'REFUNDED' }] },
    );

    const timestamp = await orders.updateMany(byTimestamp, [
      { $set: { returnedAt: '$refundedAt' } },
      { $unset: 'refundedAt' },
    ]);

    console.log(`Status renamed on: ${status.modifiedCount}`);
    console.log(`History rewritten on: ${history.modifiedCount}`);
    console.log(`Timestamp renamed on: ${timestamp.modifiedCount}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
