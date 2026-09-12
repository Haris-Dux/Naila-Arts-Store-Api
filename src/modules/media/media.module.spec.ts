import { ConfigService } from '@nestjs/config';
import { MediaConfig } from '../../config/configuration';
import { mediaStorageFactory } from './media.module';
import { LocalDiskStorage } from './storage/local-disk.storage';
import { R2Storage } from './storage/r2.storage';

/**
 * The real factory from media.module.ts, not a re-declaration of it — a copy
 * would keep passing after the module changed, which is the one thing this test
 * exists to prevent.
 */
const base: MediaConfig = {
  driver: 'local',
  root: './var/media-driver-test',
  publicPath: '/media',
  r2: {
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    publicUrl: 'https://cdn.example.com',
  },
};

const resolve = (media: MediaConfig) => {
  const config = { getOrThrow: () => media } as unknown as ConfigService;
  return mediaStorageFactory(config, new LocalDiskStorage(config));
};

describe('media storage driver', () => {
  it('resolves the disk adapter when MEDIA_DRIVER is local', () => {
    const storage = resolve({ ...base, driver: 'local' });

    expect(storage).toBeInstanceOf(LocalDiskStorage);
    // A local URL is a path this application serves.
    expect(storage.urlFor('10/abc.webp')).toBe('/media/10/abc.webp');
  });

  it('resolves the R2 adapter when MEDIA_DRIVER is r2', () => {
    const storage = resolve({ ...base, driver: 'r2' });

    expect(storage).toBeInstanceOf(R2Storage);
    // An R2 URL is absolute: the browser goes to Cloudflare, not to us.
    expect(storage.urlFor('10/abc.webp')).toBe('https://cdn.example.com/10/abc.webp');
  });

  it('releases the R2 connection pool on shutdown', () => {
    // A useFactory result is still a container instance, so Nest calls its
    // lifecycle hooks — without that the SDK's sockets hold the process open.
    const storage = resolve({ ...base, driver: 'r2' }) as R2Storage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const destroy = jest.spyOn((storage as any).client, 'destroy');

    storage.onModuleDestroy();

    expect(destroy).toHaveBeenCalled();
  });
});
