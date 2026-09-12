import { S3ServiceException } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { MediaConfig } from '../../../config/configuration';
import { R2Storage } from './r2.storage';

/**
 * No network. What is worth pinning here is the wiring the SDK is given — a
 * wrong endpoint, a missing content type or a doubled slash in the public URL
 * all fail silently in ways that only show up as a broken image weeks later.
 */
const config = (overrides: Partial<MediaConfig['r2']> = {}): ConfigService => {
  const media: MediaConfig = {
    driver: 'r2',
    root: './var/media',
    publicPath: '/media',
    r2: {
      accountId: 'acct123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'store-media',
      publicUrl: 'https://cdn.example.com',
      ...overrides,
    },
  };

  return { getOrThrow: () => media } as unknown as ConfigService;
};

describe('R2Storage', () => {
  describe('public URLs', () => {
    it('builds a URL against the custom domain', () => {
      const storage = new R2Storage(config());

      expect(storage.urlFor('10/abc.webp')).toBe('https://cdn.example.com/10/abc.webp');
    });

    it('is the storage key appended verbatim, so hashed names stay immutable', () => {
      const storage = new R2Storage(config());
      const key = 'ab/abcdef0123456789.webp';

      expect(storage.urlFor(key).endsWith(key)).toBe(true);
    });
  });

  describe('client configuration', () => {
    it('points at the account-specific R2 endpoint', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (storage as any).client;

      expect(await client.config.endpoint()).toMatchObject({
        hostname: 'acct123.r2.cloudflarestorage.com',
        protocol: 'https:',
      });
    });

    it('signs with a region, because SigV4 requires one even though R2 has none', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (storage as any).client;

      expect(await client.config.region()).toBe('auto');
    });
  });

  describe('save', () => {
    it('sends the bytes with a WebP content type and an immutable cache header', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = jest.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).client.send = send;

      const bytes = Buffer.from('webp-bytes');
      await storage.save('10/abc.webp', bytes);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].input).toEqual({
        Bucket: 'store-media',
        Key: '10/abc.webp',
        Body: bytes,
        // Without this R2 serves the object as application/octet-stream and the
        // browser downloads it rather than rendering it.
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      });
    });

    it('writes unconditionally, because the key is a content hash', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = jest.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).client.send = send;

      await storage.save('10/abc.webp', Buffer.from('x'));
      await storage.save('10/abc.webp', Buffer.from('x'));

      // Two writes, no HEAD in between: identical keys mean identical bytes, so
      // checking first would cost a round trip to prevent nothing.
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('remove', () => {
    it('deletes by key', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = jest.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).client.send = send;

      await storage.remove('10/abc.webp');

      expect(send.mock.calls[0][0].input).toEqual({
        Bucket: 'store-media',
        Key: '10/abc.webp',
      });
    });

    it('treats a missing object as success', async () => {
      const storage = new R2Storage(config());
      const notFound = new S3ServiceException({
        name: 'NoSuchKey',
        $fault: 'client',
        $metadata: { httpStatusCode: 404 },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).client.send = jest.fn().mockRejectedValue(notFound);

      // The caller wanted it gone, and it is gone.
      await expect(storage.remove('10/missing.webp')).resolves.toBeUndefined();
    });

    it('still surfaces a real failure', async () => {
      const storage = new R2Storage(config());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).client.send = jest.fn().mockRejectedValue(new Error('network down'));

      // A delete that failed for any other reason must not be reported as done,
      // or the media row disappears while the object survives.
      await expect(storage.remove('10/abc.webp')).rejects.toThrow('network down');
    });
  });
});
