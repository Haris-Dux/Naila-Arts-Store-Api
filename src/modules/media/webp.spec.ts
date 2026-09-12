import { readWebpDimensions } from './webp';

/**
 * The format check, tested directly.
 *
 * This is the only thing standing between "the client said image/webp" and what
 * actually lands on the disk, so it is worth exercising against all three chunk
 * layouts and against the shapes an attacker or a confused browser would send.
 */
describe('readWebpDimensions', () => {
  /** Build a RIFF container around a chunk, as a real encoder would. */
  const riff = (chunk: string, payload: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(chunk, 'ascii'), payload]);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WEBP', 8, 'ascii');
    return Buffer.concat([header, body]);
  };

  const lossy = (width: number, height: number): Buffer => {
    // chunk size, 3-byte frame tag, sync code, then the two 14-bit dimensions.
    const payload = Buffer.alloc(18);
    payload.writeUInt32LE(14, 0);
    payload[7] = 0x9d;
    payload[8] = 0x01;
    payload[9] = 0x2a;
    payload.writeUInt16LE(width, 10);
    payload.writeUInt16LE(height, 12);
    return riff('VP8 ', payload);
  };

  const lossless = (width: number, height: number): Buffer => {
    const payload = Buffer.alloc(14);
    payload.writeUInt32LE(10, 0);
    payload[4] = 0x2f;
    payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 5);
    return riff('VP8L', payload);
  };

  const extended = (width: number, height: number): Buffer => {
    const payload = Buffer.alloc(14);
    payload.writeUInt32LE(10, 0);
    payload.writeUIntLE(width - 1, 8, 3);
    payload.writeUIntLE(height - 1, 11, 3);
    return riff('VP8X', payload);
  };

  it('reads a simple lossy image', () => {
    expect(readWebpDimensions(lossy(1200, 1600))).toEqual({ width: 1200, height: 1600 });
  });

  it('reads a lossless image', () => {
    // Both dimensions are packed, minus one, into 28 bits — easy to be off by
    // one in either direction.
    expect(readWebpDimensions(lossless(1200, 1600))).toEqual({ width: 1200, height: 1600 });
    expect(readWebpDimensions(lossless(1, 1))).toEqual({ width: 1, height: 1 });
    expect(readWebpDimensions(lossless(16384, 16384))).toEqual({ width: 16384, height: 16384 });
  });

  it('reads an extended image, which is what alpha and animation produce', () => {
    expect(readWebpDimensions(extended(2000, 3000))).toEqual({ width: 2000, height: 3000 });
  });

  it('rejects other image formats whatever they are named', () => {
    // A JPEG, a PNG and a GIF renamed to .webp with an image/webp header — the
    // exact thing a content-type check would wave through.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array<number>(40).fill(0)]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array<number>(40).fill(0)]);
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(40)]);

    for (const bytes of [jpeg, png, gif]) {
      expect(readWebpDimensions(bytes)).toBeNull();
    }
  });

  it('rejects a RIFF container that is not WebP', () => {
    // A WAV file is also RIFF. Checking only the first four bytes would pass it.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(40),
    ]);
    expect(readWebpDimensions(wav)).toBeNull();
  });

  it('rejects a WebP header with an unknown chunk type', () => {
    expect(readWebpDimensions(riff('VP9 ', Buffer.alloc(40)))).toBeNull();
  });

  it('rejects a lossy frame with no sync code', () => {
    // Truncated or hand-crafted: the container looks right, the frame does not.
    const broken = lossy(100, 100);
    broken[23] = 0x00;
    expect(readWebpDimensions(broken)).toBeNull();
  });

  it('rejects anything too short to hold a header', () => {
    expect(readWebpDimensions(Buffer.alloc(0))).toBeNull();
    expect(readWebpDimensions(Buffer.from('RIFF', 'ascii'))).toBeNull();
    expect(readWebpDimensions(lossy(100, 100).subarray(0, 20))).toBeNull();
  });

  it('rejects a zero dimension rather than reporting it', () => {
    expect(readWebpDimensions(lossy(0, 100))).toBeNull();
    expect(readWebpDimensions(lossy(100, 0))).toBeNull();
  });
});
