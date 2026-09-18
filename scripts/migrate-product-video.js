/**
 * One-off: move every product's video from `facebookVideoUrl` to the pair that
 * replaced it, `videoUrl` + `videoPlatform`.
 *
 * Every existing video is on Facebook — that was the only platform the old
 * field accepted — so each becomes `videoPlatform: "FACEBOOK"`. The old field
 * is then removed from every product, including those where it was null.
 *
 *   MONGO_URI="mongodb://…/naila_dev?…" node scripts/migrate-product-video.js --dry-run
 *   MONGO_URI="mongodb://…/naila_dev?…" node scripts/migrate-product-video.js
 *
 * `--dry-run` counts what would change and writes nothing. The database is the
 * one named in MONGO_URI.
 *
 * Safe to run more than once: a second run finds nothing left to move. A
 * product that was already given a video through the new fields — by an admin,
 * between the deploy and this run — keeps it; its stale Facebook link is
 * dropped rather than written over the newer choice.
 *
 * Afterwards, clear the Redis catalogue cache (`catalog:*` keys): cached product
 * responses still carry the old `facebookVideoUrl` shape.
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
    const products = db.collection('products');

    // A real link on the old field, on a product the new fields have not
    // already been set for. `videoUrl: null` matches a missing field too.
    const toMove = {
      facebookVideoUrl: { $type: 'string', $ne: '' },
      videoUrl: null,
    };
    // Every product still carrying the old field in any form.
    const toStrip = { facebookVideoUrl: { $exists: true } };

    const moving = await products.countDocuments(toMove);
    const stripping = await products.countDocuments(toStrip);

    console.log(`Database: ${db.databaseName}`);
    console.log(`Products whose Facebook video moves to videoUrl: ${moving}`);
    console.log(`Products carrying the old facebookVideoUrl field: ${stripping}`);

    if (dryRun) {
      console.log('Dry run — nothing written.');
      return;
    }

    // An aggregation-pipeline update, so each document's own URL is copied.
    const moved = await products.updateMany(toMove, [
      { $set: { videoUrl: '$facebookVideoUrl', videoPlatform: 'FACEBOOK' } },
    ]);
    const stripped = await products.updateMany(toStrip, { $unset: { facebookVideoUrl: '' } });

    console.log(`Moved: ${moved.modifiedCount}`);
    console.log(`Old field removed from: ${stripped.modifiedCount}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
