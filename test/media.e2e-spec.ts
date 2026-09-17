import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Model } from 'mongoose';
import request from 'supertest';
import {
  ContentSection,
  ContentSectionDocument,
} from '../src/modules/content/schemas/content-section.schema';
import { Media, MediaDocument } from '../src/modules/media/schemas/media.schema';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

/**
 * Uploads, and the reference from a product to what was uploaded.
 *
 * The important properties are the two that a URL field could not give: a
 * product cannot point at an image that is not there, and an image the catalogue
 * uses cannot be deleted out from under it.
 */
describe('Media (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let mediaModel: Model<MediaDocument>;
  let productModel: Model<ProductDocument>;
  let sectionModel: Model<ContentSectionDocument>;
  let userModel: Model<UserDocument>;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;
  let categoryId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    mediaModel = app.get<Model<MediaDocument>>(getModelToken(Media.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    sectionModel = app.get<Model<ContentSectionDocument>>(getModelToken(ContentSection.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    // The suite writes real files; leave the working tree as it found it.
    await rm(process.env.MEDIA_ROOT ?? './var/media-test', { recursive: true, force: true });
    await ctx?.close();
  });

  /**
   * A minimal but genuine lossless WebP.
   *
   * Built rather than fixtured so the bytes are visible here: this is the thing
   * the upload path validates, and a binary blob in the repo would hide it.
   */
  const webp = (width: number, height: number, salt = 0): Buffer => {
    const payload = Buffer.alloc(18);
    payload.writeUInt32LE(14, 0);
    payload[4] = 0x2f;
    payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 5);
    // Trailing bytes differ per salt, so two calls produce different hashes.
    payload.writeUInt32LE(salt, 13);

    const body = Buffer.concat([Buffer.from('VP8L', 'ascii'), payload]);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WEBP', 8, 'ascii');
    return Buffer.concat([header, body]);
  };

  const makeUser = async (email: string, role: UserRole) => {
    const registered = await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'Test User', email, password })
      .expect(201);

    if (role !== UserRole.USER) {
      await userModel.updateOne(
        { _id: registered.body.data.user.id as string },
        { $set: { role } },
      );
    }

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);

    return login.body.data.tokens.accessToken as string;
  };

  beforeEach(async () => {
    await Promise.all([
      mediaModel.deleteMany({}),
      productModel.deleteMany({}),
      sectionModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);
    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
    categoryId = await createCategory(app, adminToken);
  });

  const uploadRaw = (files: { bytes: Buffer; name: string }[], token = adminToken) => {
    const req = request(app.getHttpServer())
      .post(api('/media'))
      .set('Authorization', `Bearer ${token}`);
    for (const file of files) {
      req.attach('files', file.bytes, { filename: file.name, contentType: 'image/webp' });
    }
    return req;
  };

  const upload = async (count = 1): Promise<string[]> => {
    const res = await uploadRaw(
      Array.from({ length: count }, (_, i) => ({ bytes: webp(1200, 1600, i), name: `p${i}.webp` })),
    ).expect(201);
    return res.body.data.map((m: { id: string }) => m.id);
  };

  const makeProduct = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Lawn Suit', price: 4999, stock: 10, categoryId, ...body });

  // ----------------------------------------------------------------- upload

  describe('uploading', () => {
    it('accepts a WebP and reports what it stored', async () => {
      const res = await uploadRaw([{ bytes: webp(1200, 1600), name: 'front.webp' }]).expect(201);

      const [media] = res.body.data;
      expect(media.contentType).toBe('image/webp');
      // Dimensions come from the file's own header, so a grid can reserve the
      // right box before the bytes arrive.
      expect(media).toMatchObject({ width: 1200, height: 1600 });
      // Every file under one `media/` prefix, named by its content hash.
      expect(media.url).toMatch(/^\/media\/media\/[0-9a-f]{64}\.webp$/);
    });

    it('writes the bytes to disk under the content hash', async () => {
      const bytes = webp(800, 800);
      const res = await uploadRaw([{ bytes, name: 'x.webp' }]).expect(201);

      const stored = await mediaModel.findById(res.body.data[0].id as string).exec();
      const onDisk = await readFile(join(process.env.MEDIA_ROOT as string, stored!.storageKey));
      expect(onDisk.equals(bytes)).toBe(true);
    });

    it('takes several files in one request, as a product form does', async () => {
      const res = await uploadRaw(
        [0, 1, 2].map((i) => ({ bytes: webp(1000, 1000, i), name: `p${i}.webp` })),
      ).expect(201);

      expect(res.body.data).toHaveLength(3);
      expect(new Set(res.body.data.map((m: { url: string }) => m.url)).size).toBe(3);
    });

    it('deduplicates identical bytes instead of storing them twice', async () => {
      const bytes = webp(900, 900);
      const first = await uploadRaw([{ bytes, name: 'a.webp' }]).expect(201);
      const second = await uploadRaw([{ bytes, name: 'renamed.webp' }]).expect(201);

      // Same photograph on two products is one file and one URL.
      expect(second.body.data[0].id).toBe(first.body.data[0].id);
      expect(await mediaModel.countDocuments({})).toBe(1);
    });

    it('rejects a non-WebP however it is labelled', async () => {
      // A JPEG named .webp with an image/webp header — exactly what a
      // content-type check would accept.
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

      const res = await uploadRaw([{ bytes: jpeg, name: 'sneaky.webp' }]).expect(400);
      expect(res.body.message).toMatch(/not a WebP/i);
      expect(await mediaModel.countDocuments({})).toBe(0);
    });

    it('rejects a file over 5MB', async () => {
      // Padded past the cap; multer stops it before the handler is reached.
      const oversized = Buffer.concat([webp(100, 100), Buffer.alloc(5 * 1024 * 1024)]);
      await uploadRaw([{ bytes: oversized, name: 'huge.webp' }]).expect(413);
      expect(await mediaModel.countDocuments({})).toBe(0);
    });

    it('rejects a request with no file', async () => {
      await request(app.getHttpServer())
        .post(api('/media'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('is admin-only', async () => {
      await uploadRaw([{ bytes: webp(100, 100), name: 'x.webp' }], shopperToken).expect(403);
      await request(app.getHttpServer()).post(api('/media')).expect(401);
    });
  });

  // --------------------------------------------------------------- serving

  describe('serving', () => {
    it('serves the file from disk with an immutable cache header', async () => {
      const res = await uploadRaw([{ bytes: webp(640, 480), name: 'x.webp' }]).expect(201);
      const url = res.body.data[0].url as string;

      // No /api prefix and no token: static middleware sits ahead of the Nest
      // router, so an image never enters the guard chain.
      const file = await request(app.getHttpServer()).get(url).expect(200);

      expect(file.headers['content-type']).toMatch(/image\/webp/);
      // The filename is the content hash, so the bytes behind a URL can never
      // change and the browser never has to ask again.
      expect(file.headers['cache-control']).toMatch(/immutable/);
      expect(file.headers['cache-control']).toMatch(/max-age=31536000/);
    });

    it('404s an unknown file rather than falling through to the API', async () => {
      await request(app.getHttpServer())
        .get('/media/aa/' + 'a'.repeat(64) + '.webp')
        .expect(404);
    });
  });

  // ------------------------------------------------------- product linkage

  describe('a product references what was uploaded', () => {
    it('resolves references to URLs and dimensions', async () => {
      const [a, b] = await upload(2);

      const created = await makeProduct({
        // Sent back-to-front, with explicit positions: the response must be in
        // the merchant's order, not the order the array happened to arrive in.
        images: [
          { mediaId: b, alt: 'Back', position: 1 },
          { mediaId: a, alt: 'Front', position: 0 },
        ],
      }).expect(201);

      // Ordered by position, not by the order they were sent.
      expect(created.body.data.images.map((i: { alt: string }) => i.alt)).toEqual([
        'Front',
        'Back',
      ]);
      expect(created.body.data.images[0]).toMatchObject({
        mediaId: a,
        width: 1200,
        height: 1600,
      });
      expect(created.body.data.images[0].url).toMatch(/^\/media\//);
    });

    it('caps a product at five images', async () => {
      const ids = await upload(5);
      await makeProduct({ images: ids.map((mediaId) => ({ mediaId })) }).expect(201);

      const rejected = await makeProduct({
        name: 'Too many',
        images: [...ids, ...(await upload(1))].map((mediaId) => ({ mediaId })),
      }).expect(400);
      expect(JSON.stringify(rejected.body)).toMatch(/at most 5 images/i);
    });

    it('refuses an image that does not exist', async () => {
      // The whole reason for a reference rather than a URL: a product cannot
      // claim a file nobody uploaded.
      const res = await makeProduct({
        images: [{ mediaId: '0123456789abcdef01234567' }],
      }).expect(400);
      expect(res.body.message).toMatch(/do not exist/i);
      expect(await productModel.countDocuments({})).toBe(0);
    });

    it('resolves images on a listing too, in one lookup', async () => {
      const [a] = await upload(1);
      await makeProduct({ images: [{ mediaId: a, alt: 'Front' }] }).expect(201);

      const listed = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(listed.body.data.items[0].images[0]).toMatchObject({ mediaId: a, width: 1200 });
    });

    it('replaces the image list on update', async () => {
      const [a, b] = await upload(2);
      const created = await makeProduct({ images: [{ mediaId: a }] }).expect(201);

      const updated = await request(app.getHttpServer())
        .patch(api(`/products/${created.body.data.id as string}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ images: [{ mediaId: b, alt: 'Only one now' }] })
        .expect(200);

      expect(updated.body.data.images).toHaveLength(1);
      expect(updated.body.data.images[0].mediaId).toBe(b);
    });
  });

  // -------------------------------------------------------------- deletion

  describe('deleting', () => {
    it('refuses while a product uses it', async () => {
      const [a] = await upload(1);
      await makeProduct({ images: [{ mediaId: a }] }).expect(201);

      const refused = await request(app.getHttpServer())
        .delete(api(`/media/${a}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(refused.body.message).toMatch(/1 product/);
    });

    it('removes the row and the file once nothing references it', async () => {
      const [a] = await upload(1);
      const stored = await mediaModel.findById(a).exec();
      const path = join(process.env.MEDIA_ROOT as string, stored!.storageKey);
      await expect(readFile(path)).resolves.toBeDefined();

      await request(app.getHttpServer())
        .delete(api(`/media/${a}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await expect(readFile(path)).rejects.toThrow();
      await request(app.getHttpServer())
        .get(api(`/media/${a}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('lets the same bytes be uploaded again afterwards', async () => {
      // The uniqueness index is scoped to live rows, so a tombstone does not
      // block a re-upload of the same photograph.
      const bytes = webp(700, 700);
      const first = await uploadRaw([{ bytes, name: 'x.webp' }]).expect(201);

      await request(app.getHttpServer())
        .delete(api(`/media/${first.body.data[0].id as string}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const again = await uploadRaw([{ bytes, name: 'x.webp' }]).expect(201);
      expect(again.body.data[0].id).not.toBe(first.body.data[0].id);
      await request(app.getHttpServer())
        .get(again.body.data[0].url as string)
        .expect(200);
    });

    it('is admin-only', async () => {
      const [a] = await upload(1);
      await request(app.getHttpServer())
        .delete(api(`/media/${a}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------- banner linkage

  describe('a banner uses what was uploaded', () => {
    // A banner stores an absolute URL; the local driver hands back a path.
    const absoluteUrl = async (id: string) => {
      const res = await request(app.getHttpServer())
        .get(api(`/media/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return `http://localhost${res.body.data.url as string}`;
    };

    const saveBanners = (urls: string[]) =>
      request(app.getHttpServer())
        .put(api('/content/sections/home_banner_slider'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ data: { items: urls.map((url) => ({ url, isActive: true })) } })
        .expect(200);

    const fileOf = async (id: string) => {
      const stored = await mediaModel.findById(id).exec();
      return join(process.env.MEDIA_ROOT as string, stored!.storageKey);
    };

    it('deletes an image taken out of the slider once the slider is saved', async () => {
      const [a, b] = await upload(2);
      await saveBanners([await absoluteUrl(a), await absoluteUrl(b)]);
      const [pathA, pathB] = [await fileOf(a), await fileOf(b)];

      await saveBanners([await absoluteUrl(b)]);

      await expect(readFile(pathA)).rejects.toThrow();
      await request(app.getHttpServer())
        .get(api(`/media/${a}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      // The slide that stayed keeps its file.
      await expect(readFile(pathB)).resolves.toBeDefined();
    });

    it('keeps an image a product still uses', async () => {
      const [a] = await upload(1);
      await makeProduct({ images: [{ mediaId: a }] }).expect(201);
      await saveBanners([await absoluteUrl(a)]);
      const path = await fileOf(a);

      await saveBanners([]);

      await expect(readFile(path)).resolves.toBeDefined();
    });

    it('refuses deleting an image the slider shows', async () => {
      const [a] = await upload(1);
      await saveBanners([await absoluteUrl(a)]);

      const refused = await request(app.getHttpServer())
        .delete(api(`/media/${a}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(refused.body.message).toMatch(/storefront section/);
    });
  });
});
