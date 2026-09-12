/**
 * WebP header parsing: format check and dimensions, from the bytes themselves.
 *
 * Two jobs in one pass, deliberately. A `Content-Type` header is whatever the
 * client typed, and a `.webp` extension is whatever they renamed the file to —
 * neither is evidence. Successfully parsing a WebP header *is* evidence, so the
 * same function that proves the format also yields the dimensions.
 *
 * Dimensions matter to the storefront: with width and height known up front a
 * product grid can reserve the right box before the image arrives, instead of
 * reflowing when it lands.
 *
 * No image library for this. Reading four header layouts is a few lines of
 * arithmetic; pulling in a native dependency to avoid them would cost more in
 * build complexity than it saves, and nothing here resizes.
 *
 * Layout — RIFF container, little-endian throughout:
 *
 *   0..3    "RIFF"
 *   4..7    file size minus 8
 *   8..11   "WEBP"
 *   12..15  chunk type: "VP8 " lossy, "VP8L" lossless, "VP8X" extended
 */

export interface WebpDimensions {
  width: number;
  height: number;
}

/** Smallest header we might need to read (VP8X canvas size ends at byte 30). */
const MIN_HEADER_BYTES = 30;

/**
 * Parse a WebP header, or return null if the bytes are not WebP.
 *
 * Null rather than throwing: "this is not a WebP" is an expected answer to an
 * upload, not an exceptional one, and the caller turns it into a 400 with a
 * message of its own.
 */
export function readWebpDimensions(buffer: Buffer): WebpDimensions | null {
  if (buffer.length < MIN_HEADER_BYTES) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return null;

  switch (buffer.toString('ascii', 12, 16)) {
    case 'VP8 ':
      return readLossy(buffer);
    case 'VP8L':
      return readLossless(buffer);
    case 'VP8X':
      return readExtended(buffer);
    default:
      return null;
  }
}

/**
 * Simple lossy. The VP8 keyframe carries a three-byte sync code, which doubles
 * as a check that we are looking at a real frame and not a truncated file.
 */
function readLossy(buffer: Buffer): WebpDimensions | null {
  if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;

  return dimensions(
    // 14 significant bits; the top two are the scaling hint, which nothing uses.
    buffer.readUInt16LE(26) & 0x3fff,
    buffer.readUInt16LE(28) & 0x3fff,
  );
}

/** Lossless. Both dimensions are packed, minus one, into 28 bits after the signature. */
function readLossless(buffer: Buffer): WebpDimensions | null {
  if (buffer[20] !== 0x2f) return null;

  const bits = buffer.readUInt32LE(21);
  return dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
}

/** Extended — animation, alpha, metadata. The canvas size is 24 bits each, minus one. */
function readExtended(buffer: Buffer): WebpDimensions | null {
  return dimensions(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
}

function dimensions(width: number, height: number): WebpDimensions | null {
  // A zero dimension is a malformed header, not a zero-pixel image.
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
