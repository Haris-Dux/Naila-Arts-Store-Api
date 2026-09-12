import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { Category, CategoryDocument } from '../src/modules/categories/schemas/category.schema';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

describe('Catalog & Inventory (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let productModel: Model<ProductDocument>;
  let categoryModel: Model<CategoryDocument>;
  let userModel: Model<UserDocument>;
  let inventory: InventoryService;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;
  let categoryId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    categoryModel = app.get<Model<CategoryDocument>>(getModelToken(Category.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    inventory = app.get(InventoryService);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  /** Register a user, force a role, then log in so the token carries it. */
  const makeUser = async (email: string, role: UserRole) => {
    const registered = await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'Test User', email, password })
      .expect(201);

    const id = registered.body.data.user.id as string;
    if (role !== UserRole.USER) {
      await userModel.updateOne({ _id: id }, { $set: { role } });
    }

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);

    return { id, token: login.body.data.tokens.accessToken as string };
  };

  beforeEach(async () => {
    await Promise.all([
      productModel.deleteMany({}),
      categoryModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);

    adminToken = (await makeUser('admin@example.com', UserRole.ADMIN)).token;
    shopperToken = (await makeUser('shopper@example.com', UserRole.USER)).token;
    categoryId = await createCategory(app, adminToken);
  });

  /** Upload real WebP bytes and hand back the ids a product can reference. */
  const uploadImages = async (count: number): Promise<string[]> => {
    const req = request(app.getHttpServer())
      .post(api('/media'))
      .set('Authorization', `Bearer ${adminToken}`);

    for (let i = 0; i < count; i += 1) {
      // A minimal lossless WebP; the trailing salt makes each one a distinct file.
      const payload = Buffer.alloc(18);
      payload.writeUInt32LE(14, 0);
      payload[4] = 0x2f;
      payload.writeUInt32LE((799 << 14) | 799, 5);
      payload.writeUInt32LE(i, 13);
      const body = Buffer.concat([Buffer.from('VP8L', 'ascii'), payload]);
      const header = Buffer.alloc(12);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(4 + body.length, 4);
      header.write('WEBP', 8, 'ascii');
      req.attach('files', Buffer.concat([header, body]), {
        filename: `img${i}.webp`,
        contentType: 'image/webp',
      });
    }

    const res = await req.expect(201);
    return res.body.data.map((m: { id: string }) => m.id);
  };

  const createProduct = (overrides: Record<string, unknown> = {}, token = adminToken) =>
    request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wireless Mouse', price: 2499, stock: 10, categoryId, ...overrides });

  // ------------------------------------------------------------------- A1

  describe('stock is atomic and cannot oversell (A1)', () => {
    it('rejects a decrement larger than available stock', async () => {
      const created = await createProduct({ stock: 5 }).expect(201);
      const id = created.body.data.id as string;

      await expect(inventory.decrease(id, 6)).rejects.toMatchObject({
        code: 'INSUFFICIENT_STOCK',
      });

      const after = await productModel.findById(id).exec();
      expect(after?.stock).toBe(5);
    });

    it('never lets stock go negative under concurrency', async () => {
      const created = await createProduct({ stock: 5 }).expect(201);
      const id = created.body.data.id as string;

      // 20 simultaneous single-unit decrements against 5 units of stock.
      // The old read-modify-write would lose updates and finish negative.
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => inventory.decrease(id, 1)),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      expect(succeeded).toBe(5);
      expect(failed).toBe(15);

      const after = await productModel.findById(id).exec();
      expect(after?.stock).toBe(0);
      expect(after?.stock).toBeGreaterThanOrEqual(0);
      // Exactly the units actually sold.
      expect(after?.sellCount).toBe(5);
    });

    it('keeps a multi-unit decrement all-or-nothing under concurrency', async () => {
      const created = await createProduct({ stock: 10 }).expect(201);
      const id = created.body.data.id as string;

      // Four concurrent 3-unit orders against 10 units: three can succeed (9),
      // the fourth cannot be partially filled.
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => inventory.decrease(id, 3)),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const after = await productModel.findById(id).exec();

      expect(succeeded).toBe(3);
      expect(after?.stock).toBe(1);
    });

    it('reports a missing product distinctly from insufficient stock', async () => {
      await expect(inventory.decrease('507f1f77bcf86cd799439011', 1)).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('rejects a non-positive quantity', async () => {
      const created = await createProduct().expect(201);
      const id = created.body.data.id as string;

      await expect(inventory.decrease(id, 0)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(inventory.decrease(id, -5)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(inventory.decrease(id, 1.5)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('restores stock and floors sellCount at zero', async () => {
      const created = await createProduct({ stock: 5 }).expect(201);
      const id = created.body.data.id as string;

      await inventory.decrease(id, 3);
      await inventory.restore(id, 3);

      const after = await productModel.findById(id).exec();
      expect(after?.stock).toBe(5);
      expect(after?.sellCount).toBe(0);
    });
  });

  // ------------------------------------------------------------- B11 / B12

  // B11 — a product-owner field that never reached the database — is retired
  // rather than fixed: a single-merchant catalogue has no per-product owner.
  describe('fields that used to be silently dropped (B12)', () => {
    it('persists categoryId, rating and sellCount', async () => {
      const category = await request(app.getHttpServer())
        .post(api('/categories'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Electronics' })
        .expect(201);

      const created = await createProduct({ categoryId: category.body.data.id }).expect(201);

      expect(created.body.data.categoryId).toBe(category.body.data.id);
      expect(created.body.data.rating).toEqual({ average: 0, count: 0 });
      expect(created.body.data.sellCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------ B13

  describe('images are returned (B13)', () => {
    it('returns images on the single product and on the list alike', async () => {
      // The old service never passed `relations: ['images']`, so the catalogue
      // had no images at all. A listing is where they matter most, so both paths
      // resolve them — see media.e2e-spec.ts for uploading and referencing.
      const [a, b] = await uploadImages(2);

      const created = await createProduct({
        images: [
          { mediaId: b, position: 1 },
          { mediaId: a, position: 0, alt: 'Front' },
        ],
      }).expect(201);

      expect(created.body.data.images).toHaveLength(2);
      // Sorted by position, not insertion order.
      expect(created.body.data.images[0].mediaId).toBe(a);
      expect(created.body.data.images[0].alt).toBe('Front');
      expect(created.body.data.images[0].url).toMatch(/^\/media\//);

      const fetched = await request(app.getHttpServer())
        .get(api(`/products/${created.body.data.id}`))
        .expect(200);
      expect(fetched.body.data.images).toHaveLength(2);

      const listed = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(listed.body.data.items[0].images).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------ B15

  describe('cache correctness (B15)', () => {
    it('reflects a price change immediately rather than serving a stale page', async () => {
      const created = await createProduct({ price: 2499 }).expect(201);
      const id = created.body.data.id as string;

      // Prime both caches.
      await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .expect(200);
      await request(app.getHttpServer()).get(api('/products')).expect(200);

      await request(app.getHttpServer())
        .patch(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ price: 1999 })
        .expect(200);

      // The old catalogue cached list pages for an hour and never invalidated
      // them, so a price change took an hour to appear.
      const single = await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .expect(200);
      expect(single.body.data.price.amount).toBe(1999);

      const list = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(list.body.data.items[0].price.amount).toBe(1999);
    });

    it('drops a deleted product from cached listings', async () => {
      const created = await createProduct().expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer()).get(api('/products')).expect(200);

      await request(app.getHttpServer())
        .delete(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      const list = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(list.body.data.items).toHaveLength(0);

      await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .expect(404);
    });

    const bySlug = (slug: string) =>
      request(app.getHttpServer()).get(api(`/products/slug/${slug}`));

    const editProduct = (id: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(200);

    it('serves a product page by slug from the cache, and refreshes it on edit', async () => {
      const created = await createProduct({ name: 'Cached Lawn Suit', price: 2499 }).expect(201);
      const { id, slug } = created.body.data as { id: string; slug: string };

      await bySlug(slug).expect(200);

      // A change that bypasses the service is invisible until the entry expires —
      // proof the second read came from the cache, not the database.
      await productModel.updateOne({ _id: id }, { $set: { price: 1 } });
      expect((await bySlug(slug).expect(200)).body.data.price.amount).toBe(2499);

      await editProduct(id, { price: 1999 });

      expect((await bySlug(slug).expect(200)).body.data.price.amount).toBe(1999);
    });

    it('stops serving a cached product page once it is renamed or unpublished', async () => {
      const created = await createProduct({ name: 'Rose Chiffon' }).expect(201);
      const { id, slug } = created.body.data as { id: string; slug: string };
      await bySlug(slug).expect(200);

      await editProduct(id, { slug: 'rose-chiffon-2026' });
      await bySlug(slug).expect(404);
      await bySlug('rose-chiffon-2026').expect(200);

      await editProduct(id, { isActive: false });
      await bySlug('rose-chiffon-2026').expect(404);
    });

    it('serves feed batches from the cache, and retires them on any catalogue change', async () => {
      for (const name of ['Feed One', 'Feed Two', 'Feed Three']) {
        await createProduct({ name, stock: 5 }).expect(201);
      }
      const feed = (cursor?: string) =>
        request(app.getHttpServer())
          .get(
            api(
              `/products?paginate=cursor&limit=2&sort=createdAt&order=desc${cursor ? `&cursor=${cursor}` : ''}`,
            ),
          )
          .expect(200);

      const first = await feed();
      const cursor = first.body.data.meta.nextCursor as string;
      const second = await feed(cursor);
      const lastId = second.body.data.items[0].id as string;

      // Behind the service's back: both cached batches must keep what they had.
      await productModel.updateMany({}, { $set: { name: 'Changed Behind The Cache' } });
      expect((await feed()).body.data.items[0].name).toBe(first.body.data.items[0].name);
      expect((await feed(cursor)).body.data.items[0].name).toBe(second.body.data.items[0].name);

      // A stock change through inventory announces itself, which retires every
      // batch — the first page and the one reached by cursor alike.
      await inventory.decrease(lastId, 1);
      expect((await feed()).body.data.items[0].name).toBe('Changed Behind The Cache');
      const refreshed = (await feed(cursor)).body.data.items[0];
      expect(refreshed.name).toBe('Changed Behind The Cache');
      expect(refreshed.stock).toBe(4);
    });

    it('never serves the staff view of the feed to a shopper', async () => {
      await createProduct({ name: 'Published Piece' }).expect(201);
      await createProduct({ name: 'Draft Piece', isActive: false }).expect(201);

      const staff = await request(app.getHttpServer())
        .get(api('/products?paginate=cursor&includeInactive=true'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(staff.body.data.items.map((p: { name: string }) => p.name)).toContain('Draft Piece');

      const shopper = await request(app.getHttpServer())
        .get(api('/products?paginate=cursor'))
        .expect(200);
      expect(shopper.body.data.items.map((p: { name: string }) => p.name)).toEqual([
        'Published Piece',
      ]);
    });

    it('serves the category tree from the cache until a category is edited', async () => {
      const treeNames = async () => {
        const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
        return tree.body.data.map((c: { name: string }) => c.name);
      };
      const listNames = async () => {
        const list = await request(app.getHttpServer()).get(api('/categories')).expect(200);
        return list.body.data.map((c: { name: string }) => c.name);
      };
      expect(await treeNames()).toEqual(['Test Category']);
      expect(await listNames()).toEqual(['Test Category']);

      // Behind the cache: a cached read does not see it.
      await categoryModel.updateOne({ _id: categoryId }, { $set: { name: 'Changed Behind' } });
      expect(await treeNames()).toEqual(['Test Category']);
      expect(await listNames()).toEqual(['Test Category']);

      await request(app.getHttpServer())
        .patch(api(`/categories/${categoryId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Renamed Category' })
        .expect(200);

      expect(await treeNames()).toEqual(['Renamed Category']);
      expect(await listNames()).toEqual(['Renamed Category']);
    });
  });

  // --------------------------------------------------------------- B8 / B9

  describe('awaited reads and real 404s (B8, B9)', () => {
    it('returns 404 for an unknown product instead of succeeding', async () => {
      // The gateway's `if (!product)` tested an unawaited Promise — always
      // truthy — so the 404 branch was unreachable.
      const res = await request(app.getHttpServer()).get(api('/products/507f1f77bcf86cd799439011'));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns 404 for a malformed id rather than 500', async () => {
      await request(app.getHttpServer()).get(api('/products/not-an-id')).expect(404);
    });

    it('actually deletes, and reports 404 on the second attempt', async () => {
      // The old delete never awaited `repository.delete(id)` and returned the
      // pending Promise as the "deleted product".
      const created = await createProduct().expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer())
        .delete(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      const stored = await productModel.findById(id).exec();
      expect(stored?.deletedAt).not.toBeNull();

      await request(app.getHttpServer())
        .delete(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // ------------------------------------------------------------------- C6

  describe('cursor pagination for infinite scroll', () => {
    const feed = (params = '') =>
      request(app.getHttpServer()).get(api(`/products?paginate=cursor${params}`));

    /** Walk the whole feed, following nextCursor, and return every id seen. */
    const drain = async (params = '', limit = 3, mutate?: () => Promise<unknown>) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;

      do {
        // Annotated: without it `res` and `cursor` infer through each other.
        const res: request.Response = await feed(
          `${params}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ).expect(200);

        seen.push(...res.body.data.items.map((p: { id: string }) => p.id));
        cursor = res.body.data.meta.nextCursor as string | null;

        // Simulate a write landing between two scroll ticks.
        if (mutate && guard === 0) await mutate();
      } while (cursor && ++guard < 50);

      return seen;
    };

    it('returns cursor meta instead of page meta', async () => {
      await createProduct({ name: 'A', price: 100 }).expect(201);
      await createProduct({ name: 'B', price: 200 }).expect(201);

      const res = await feed('&limit=1').expect(200);

      expect(res.body.data.meta).toEqual({
        limit: 1,
        hasNext: true,
        nextCursor: expect.any(String),
      });
      // No total: counting the whole set on every scroll tick is the cost this
      // mode exists to avoid.
      expect(res.body.data.meta).not.toHaveProperty('total');
      expect(res.body.data.items).toHaveLength(1);
    });

    it('walks the whole catalogue exactly once', async () => {
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        await createProduct({ name, price: 100 }).expect(201);
      }

      const seen = await drain('', 3);

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });

    it('ends with a null cursor rather than an empty page', async () => {
      await createProduct({ name: 'Only', price: 100 }).expect(201);

      const res = await feed('&limit=10').expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.meta.hasNext).toBe(false);
      expect(res.body.data.meta.nextCursor).toBeNull();
    });

    it('never repeats an item when a product is published mid-scroll', async () => {
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
        await createProduct({ name, price: 100 }).expect(201);
      }

      // The offset equivalent shifts every later page by one and hands the
      // reader the boundary item a second time.
      const seen = await drain('', 2, () =>
        createProduct({ name: 'Published mid-scroll', price: 100 }).expect(201),
      );

      expect(new Set(seen).size).toBe(seen.length);
    });

    it('never skips an item when a product is removed mid-scroll', async () => {
      const ids: string[] = [];
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
        const res = await createProduct({ name, price: 100 }).expect(201);
        ids.push(res.body.data.id as string);
      }

      // Delete something already behind the reader: nothing ahead should move.
      const seen = await drain('', 2, async () => {
        await request(app.getHttpServer())
          .delete(api(`/products/${ids[ids.length - 1]}`))
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(204);
      });

      const survivors = ids.slice(0, -1);
      expect(new Set(seen).size).toBe(seen.length);
      // Every product that still exists was seen.
      survivors.forEach((id) => expect(seen).toContain(id));
    });

    it('paginates a sort whose values are mostly tied', async () => {
      // `sellCount` is 0 for everything here. Without the _id tiebreaker in the
      // keyset comparison, the second page would skip every product sharing the
      // anchor's value — which is all of them.
      for (const name of ['A', 'B', 'C', 'D', 'E']) {
        await createProduct({ name, price: 100 }).expect(201);
      }

      const seen = await drain('&sort=sellCount&order=desc', 2);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('paginates ascending as well as descending', async () => {
      for (const [name, price] of [
        ['A', 300],
        ['B', 100],
        ['C', 200],
      ] as const) {
        await createProduct({ name, price }).expect(201);
      }

      const res = await feed('&sort=effectivePrice&order=asc&limit=2').expect(200);
      expect(res.body.data.items.map((p: { name: string }) => p.name)).toEqual(['B', 'C']);

      const next = await feed(
        `&sort=effectivePrice&order=asc&limit=2&cursor=${encodeURIComponent(res.body.data.meta.nextCursor)}`,
      ).expect(200);
      expect(next.body.data.items.map((p: { name: string }) => p.name)).toEqual(['A']);
    });

    it('honours filters across the whole walk', async () => {
      const other = await createCategory(app, adminToken, 'Other');
      for (const name of ['In1', 'In2', 'In3']) {
        await createProduct({ name, price: 100 }).expect(201);
      }
      await createProduct({ name: 'Out', price: 100, categoryId: other }).expect(201);

      const seen = await drain(`&categoryId=${categoryId}`, 2);

      expect(seen).toHaveLength(3);
    });

    it('refuses relevance, which has no stored value to anchor to', async () => {
      const res = await feed('&sort=relevance&search=suit').expect(400);
      expect(res.body.message).toMatch(/relevance/i);
    });

    it('refuses a malformed cursor rather than silently restarting', async () => {
      await feed('&cursor=not-a-cursor').expect(400);
      await feed(`&cursor=${Buffer.from('{}').toString('base64url')}`).expect(400);
    });

    it('hides inactive products from shoppers', async () => {
      await createProduct({ name: 'Live', price: 100 }).expect(201);
      await createProduct({ name: 'Draft', price: 100, isActive: false }).expect(201);

      const res = await feed('&limit=10').expect(200);

      expect(res.body.data.items.map((p: { name: string }) => p.name)).toEqual(['Live']);
    });

    it('leaves page pagination untouched', async () => {
      await createProduct({ name: 'A', price: 100 }).expect(201);

      const res = await request(app.getHttpServer()).get(api('/products')).expect(200);

      // The dashboard still gets numbered pages and a total.
      expect(res.body.data.meta).toMatchObject({ total: 1, page: 1, pages: 1 });
    });
  });

  describe('sort allow-list (C6)', () => {
    it('rejects an unlisted sort field', async () => {
      // `deletedAt` is a real column and still refused — the allow-list is not a
      // schema check, it is a list of fields a caller is permitted to order by.
      await request(app.getHttpServer()).get(api('/products?sort=deletedAt')).expect(400);
      await request(app.getHttpServer())
        .get(api('/products?sort=price;DROP TABLE products'))
        .expect(400);
    });

    it('sorts by stock, which the low-stock report needs', async () => {
      await createProduct({ name: 'Plenty', price: 500, stock: 40 }).expect(201);
      await createProduct({ name: 'Scarce', price: 500, stock: 2 }).expect(201);

      const res = await request(app.getHttpServer())
        .get(api('/products?sort=stock&order=asc'))
        .expect(200);

      expect(res.body.data.items.map((p: { name: string }) => p.name)).toEqual([
        'Scarce',
        'Plenty',
      ]);
    });

    it('accepts allow-listed fields', async () => {
      await createProduct({ name: 'A', price: 500 }).expect(201);
      await createProduct({ name: 'B', price: 100 }).expect(201);

      const res = await request(app.getHttpServer())
        .get(api('/products?sort=effectivePrice&order=asc'))
        .expect(200);

      expect(
        res.body.data.items.map(
          (p: { effectivePrice: { amount: number } }) => p.effectivePrice.amount,
        ),
      ).toEqual([100, 500]);
    });

    it('sorts by what is charged, not the list price', async () => {
      // `price` is no longer sortable: with promotions running it orders the
      // storefront by a number nobody is paying.
      await createProduct({ name: 'Cheap list, no offer', price: 500 }).expect(201);
      await createProduct({
        name: 'Dear list, on offer',
        price: 900,
        promotionalPrice: 100,
      }).expect(201);

      await request(app.getHttpServer()).get(api('/products?sort=price')).expect(400);

      const res = await request(app.getHttpServer())
        .get(api('/products?sort=effectivePrice&order=asc'))
        .expect(200);

      expect(res.body.data.items.map((p: { name: string }) => p.name)).toEqual([
        'Dear list, on offer',
        'Cheap list, no offer',
      ]);
    });
  });

  describe('pricing', () => {
    it('stores and returns money as integer minor units', async () => {
      const created = await createProduct({ price: 2499 }).expect(201);

      expect(created.body.data.price).toEqual({
        amount: 2499,
        currency: 'USD',
        formatted: '$24.99',
      });

      const stored = await productModel.findById(created.body.data.id).exec();
      expect(stored?.price).toBe(2499);
      expect(Number.isInteger(stored?.price)).toBe(true);
    });

    it('rejects a decimal price', async () => {
      // Accepting 24.99 as a float is how prices drift by a cent.
      await createProduct({ price: 24.99 }).expect(400);
    });

    it('rejects a negative price', async () => {
      await createProduct({ price: -100 }).expect(400);
    });
  });

  describe('authorization', () => {
    it('lets anyone browse but not create', async () => {
      await request(app.getHttpServer()).get(api('/products')).expect(200);
      await request(app.getHttpServer())
        .post(api('/products'))
        .send({ name: 'X', price: 100 })
        .expect(401);
    });

    it('stops a shopper creating a product', async () => {
      await createProduct({}, shopperToken).expect(403);
    });

    it('lets any admin edit any product', async () => {
      // There is no per-owner catalogue: administrators are peers who all
      // manage the same single-merchant store.
      const created = await createProduct().expect(201);
      const other = await makeUser('other-admin@example.com', UserRole.ADMIN);

      await request(app.getHttpServer())
        .patch(api(`/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${other.token}`)
        .send({ name: 'Renamed by a colleague' })
        .expect(200);
    });

    it('rejects stock on a catalogue update', async () => {
      const created = await createProduct({ stock: 10 }).expect(201);

      // Stock moves only through inventory, so a catalogue edit cannot clobber
      // a concurrent sale's decrement.
      await request(app.getHttpServer())
        .patch(api(`/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ stock: 999 })
        .expect(400);

      const stored = await productModel.findById(created.body.data.id).exec();
      expect(stored?.stock).toBe(10);
    });
  });

  describe('visibility', () => {
    it('hides inactive products from shoppers but shows them to staff', async () => {
      const created = await createProduct({ isActive: false }).expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .expect(404);

      const anonymousList = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(anonymousList.body.data.items).toHaveLength(0);

      const staffView = await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(staffView.body.data.isActive).toBe(false);

      const staffList = await request(app.getHttpServer())
        .get(api('/products?includeInactive=true'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(staffList.body.data.items).toHaveLength(1);
    });

    it('ignores includeInactive for a shopper', async () => {
      await createProduct({ isActive: false }).expect(201);

      const res = await request(app.getHttpServer())
        .get(api('/products?includeInactive=true'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(0);
    });
  });

  describe('slugs and SKUs', () => {
    it('generates a unique slug from the name', async () => {
      const first = await createProduct({ name: 'Wireless Mouse' }).expect(201);
      const second = await createProduct({ name: 'Wireless Mouse' }).expect(201);

      expect(first.body.data.slug).toBe('wireless-mouse');
      expect(second.body.data.slug).toBe('wireless-mouse-1');
    });

    it('serves a product by slug', async () => {
      const created = await createProduct({ name: 'Mechanical Keyboard' }).expect(201);

      const res = await request(app.getHttpServer())
        .get(api(`/products/slug/${created.body.data.slug}`))
        .expect(200);

      expect(res.body.data.id).toBe(created.body.data.id);
    });

    it('rejects a duplicate SKU with 409', async () => {
      await createProduct({ sku: 'SKU-001' }).expect(201);
      const res = await createProduct({ name: 'Another', sku: 'SKU-001' }).expect(409);
      expect(res.body.code).toBe('CONFLICT');
    });

    it('allows many products without a SKU', async () => {
      // The partial unique index must not treat repeated nulls as collisions.
      await createProduct({ name: 'One' }).expect(201);
      await createProduct({ name: 'Two' }).expect(201);
      await createProduct({ name: 'Three' }).expect(201);
    });
  });

  describe('search and filtering', () => {
    beforeEach(async () => {
      await createProduct({ name: 'Wireless Mouse', price: 2499 }).expect(201);
      await createProduct({ name: 'Mechanical Keyboard', price: 7990 }).expect(201);
      await createProduct({ name: 'Bluetooth Headphones', price: 5950, stock: 0 }).expect(201);
    });

    it('searches by text', async () => {
      const res = await request(app.getHttpServer())
        .get(api('/products?search=keyboard'))
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].name).toBe('Mechanical Keyboard');
    });

    it('filters by price range', async () => {
      const res = await request(app.getHttpServer())
        .get(api('/products?minPrice=3000&maxPrice=8000'))
        .expect(200);

      expect(res.body.data.items).toHaveLength(2);
    });

    it('filters to in-stock only', async () => {
      const res = await request(app.getHttpServer()).get(api('/products?inStock=true')).expect(200);

      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items.every((p: { inStock: boolean }) => p.inStock)).toBe(true);
    });

    it('paginates with 1-indexed pages and correct metadata', async () => {
      const res = await request(app.getHttpServer())
        .get(api('/products?page=1&limit=2'))
        .expect(200);

      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.meta).toMatchObject({
        total: 3,
        page: 1,
        limit: 2,
        pages: 2,
        hasNext: true,
        hasPrevious: false,
      });
    });
  });

  describe('rich-text descriptions', () => {
    const search = (term: string) =>
      request(app.getHttpServer())
        .get(api(`/products?search=${term}`))
        .expect(200);

    it('keeps the formatting the editor produces', async () => {
      const html =
        '<h2 style="text-align: center">Soft lawn</h2>' +
        '<p>Three <strong>piece</strong> <em>suit</em>, <u>printed</u>, <s>was</s>.</p>' +
        '<ul><li>Shirt</li></ul><ol><li>Dupatta</li></ol><blockquote><p>Quoted</p></blockquote>' +
        '<p><a href="https://example.com/size-guide">Size guide</a></p>';

      const res = await createProduct({ description: html }).expect(201);
      const stored: string = res.body.data.description;

      expect(stored).toMatch(/<h2 style="text-align: ?center;?">Soft lawn<\/h2>/);
      expect(stored).toContain('<strong>piece</strong> <em>suit</em>, <u>printed</u>, <s>was</s>');
      expect(stored).toContain('<ul><li>Shirt</li></ul><ol><li>Dupatta</li></ol>');
      expect(stored).toContain('<blockquote><p>Quoted</p></blockquote>');
      expect(stored).toMatch(/<a [^>]*href="https:\/\/example\.com\/size-guide"/);
      expect(stored).toMatch(/<a [^>]*target="_blank"/);
      expect(stored).toMatch(/<a [^>]*rel="noopener noreferrer"/);
    });

    it('strips anything the editor cannot produce', async () => {
      const html =
        '<p onclick="steal()" style="color: red; text-align: right">Hello</p>' +
        '<script>alert(1)</script><iframe src="https://evil.example"></iframe>' +
        '<a href="javascript:alert(1)">bad link</a><img src="x" onerror="alert(1)">';

      const res = await createProduct({ description: html }).expect(201);
      const stored: string = res.body.data.description;

      expect(stored).toContain('Hello');
      expect(stored).toContain('text-align');
      for (const banned of [
        'onclick',
        'color',
        '<script',
        'alert',
        '<iframe',
        'javascript:',
        '<img',
        'onerror',
      ]) {
        expect(stored).not.toContain(banned);
      }
    });

    it("drops the editor's trailing empty paragraph", async () => {
      const res = await createProduct({
        description: '<p>Soft lawn</p><ul><li><p>Shirt</p></li></ul><p></p>',
      }).expect(201);

      expect(res.body.data.description).toBe('<p>Soft lawn</p><ul><li><p>Shirt</p></li></ul>');
    });

    it('stores an empty editor as no description', async () => {
      const res = await createProduct({ description: '<p></p>' }).expect(201);
      expect(res.body.data.description).toBeNull();
    });

    it('searches the words, not the markup', async () => {
      await createProduct({
        name: 'Plain Kurta',
        description: '<p>A <strong>breathable</strong> summer fabric</p>',
      }).expect(201);

      expect((await search('breathable')).body.data.items).toHaveLength(1);
      // "strong" is only a tag name here. Indexing the HTML would match it.
      expect((await search('strong')).body.data.items).toHaveLength(0);
    });

    it('keeps an edited description sanitised and searchable', async () => {
      const created = await createProduct({ description: '<p>Old words</p>' }).expect(201);

      const res = await request(app.getHttpServer())
        .patch(api(`/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ description: '<p>Embroidered <em>chiffon</em></p><script>x()</script>' })
        .expect(200);

      expect(res.body.data.description).toBe('<p>Embroidered <em>chiffon</em></p>');
      expect((await search('embroidered')).body.data.items).toHaveLength(1);
    });
  });

  describe('facebook video', () => {
    const url = 'https://www.facebook.com/watch/?v=1234567890';

    it('accepts a video on Facebook, and removes it with null', async () => {
      const created = await createProduct({ facebookVideoUrl: url }).expect(201);
      expect(created.body.data.facebookVideoUrl).toBe(url);

      const cleared = await request(app.getHttpServer())
        .patch(api(`/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ facebookVideoUrl: null })
        .expect(200);
      expect(cleared.body.data.facebookVideoUrl).toBeNull();
    });

    it('accepts a fb.watch short link', async () => {
      await createProduct({ facebookVideoUrl: 'https://fb.watch/abc123XYZ/' }).expect(201);
    });

    it('refuses a link that is not an https Facebook link', async () => {
      await createProduct({ facebookVideoUrl: 'https://www.youtube.com/watch?v=abc' }).expect(400);
      await createProduct({ facebookVideoUrl: 'http://www.facebook.com/watch/?v=1' }).expect(400);
      await createProduct({ facebookVideoUrl: 'https://facebook.com.evil.example/v' }).expect(400);
    });
  });

  describe('categories', () => {
    it('refuses to delete a category that still has products', async () => {
      const category = await request(app.getHttpServer())
        .post(api('/categories'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Electronics' })
        .expect(201);

      await createProduct({ categoryId: category.body.data.id }).expect(201);

      const res = await request(app.getHttpServer())
        .delete(api(`/categories/${category.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/reassign/i);
    });

    it('stops a customer creating a category', async () => {
      await request(app.getHttpServer())
        .post(api('/categories'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ name: 'Sneaky' })
        .expect(403);
    });
  });

  describe('inventory endpoints', () => {
    it('reads a stock level', async () => {
      const created = await createProduct({ stock: 5 }).expect(201);

      const res = await request(app.getHttpServer())
        .get(api(`/inventory/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.stock).toBe(5);
    });

    it('keeps stock reads to admins', async () => {
      const created = await createProduct().expect(201);

      await request(app.getHttpServer())
        .get(api(`/inventory/products/${created.body.data.id}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(403);
    });

    it('requires authentication', async () => {
      const created = await createProduct().expect(201);
      await request(app.getHttpServer())
        .get(api(`/inventory/products/${created.body.data.id}`))
        .expect(401);
    });

    it('no longer accepts manual stock writes', async () => {
      // Replenishment belongs to the ERP now; a second place to type a number
      // would be a second answer to "how many are there".
      const created = await createProduct({ stock: 5 }).expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer())
        .post(api(`/inventory/products/${id}/receive`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 20 })
        .expect(404);

      await request(app.getHttpServer())
        .patch(api(`/inventory/products/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quantity: 100 })
        .expect(404);
    });
  });
});
