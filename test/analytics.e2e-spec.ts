import { INestApplication } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OrderStatus } from '../src/modules/orders/enums/order-status.enum';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

describe('Analytics (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let orderModel: Model<OrderDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let cache: Cache;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;
  let categoryId: string;

  const address = {
    fullName: 'Jane Doe',
    line1: '12 Market Street',
    city: 'Manchester',
    postalCode: 'M1 1AA',
    country: 'GB',
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    cache = app.get<Cache>(CACHE_MANAGER);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const makeUser = async (email: string, role: UserRole) => {
    const registered = await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'Test User', email, password })
      .expect(201);

    const id = registered.body.data.user.id as string;
    if (role !== UserRole.USER) await userModel.updateOne({ _id: id }, { $set: { role } });

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);

    return { id, token: login.body.data.tokens.accessToken as string };
  };

  const createProduct = async (name: string, price: number, stock = 100) => {
    const res = await request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, price, stock, categoryId })
      .expect(201);
    return res.body.data.id as string;
  };

  const checkout = async (items: { productId: string; quantity: number }[], token?: string) => {
    const req = request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Idempotency-Key', randomUUID());

    if (token) req.set('Authorization', `Bearer ${token}`);

    const res = await req
      .send({
        shippingAddress: address,
        items,
        // A guest names themselves on the order; a signed-in shopper's contact
        // details are read from their account and cannot be sent.
        ...(token ? {} : { email: 'guest@example.com', name: 'Guest Buyer' }),
      })
      .expect(201);

    return res.body.data.id as string;
  };

  /** Move an order's placedAt so a test can put it in a chosen window. */
  const placeAt = (orderId: string, at: Date) =>
    orderModel.updateOne({ _id: orderId }, { $set: { placedAt: at } });

  const setStatus = (orderId: string, status: OrderStatus) =>
    orderModel.updateOne({ _id: orderId }, { $set: { status } });

  const get = (path: string, token = adminToken) =>
    request(app.getHttpServer()).get(api(path)).set('Authorization', `Bearer ${token}`);

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  beforeEach(async () => {
    await Promise.all([
      orderModel.deleteMany({}),
      productModel.deleteMany({}),
      userModel.deleteMany({}),
      // Analytics answers are cached for a minute against a minute-aligned
      // window, so without this a figure computed in one test is served to the
      // next. Wiping Mongo is not enough on its own.
      cache.clear(),
    ]);

    adminToken = (await makeUser('admin@example.com', UserRole.ADMIN)).token;
    shopperToken = (await makeUser('shopper@example.com', UserRole.USER)).token;
    categoryId = await createCategory(app, adminToken);
  });

  describe('access', () => {
    it('refuses a shopper', async () => {
      await get('/analytics/summary', shopperToken).expect(403);
    });

    it('refuses an anonymous caller', async () => {
      await request(app.getHttpServer()).get(api('/analytics/summary')).expect(401);
    });
  });

  describe('the revenue definition', () => {
    it('counts a PENDING order, because a cash-on-delivery sale never reaches PAID', async () => {
      const productId = await createProduct('Lawn Suit', 5000);
      const orderId = await checkout([{ productId, quantity: 2 }], shopperToken);
      await placeAt(orderId, daysAgo(1));

      // Left in PENDING deliberately — this is the COD path, and the whole
      // reason the definition is a deny-list.
      const order = await orderModel.findById(orderId).lean().exec();
      expect(order?.status).toBe(OrderStatus.PENDING);

      const res = await get('/analytics/summary').expect(200);

      expect(res.body.data.revenue.current.amount).toBe(10_000);
      expect(res.body.data.orders.current).toBe(1);
      expect(res.body.data.countedStatuses).toContain('PENDING');
    });

    it('drops a cancelled order from revenue', async () => {
      const productId = await createProduct('Lawn Suit', 5000);
      const keep = await checkout([{ productId, quantity: 1 }], shopperToken);
      const cancel = await checkout([{ productId, quantity: 1 }], shopperToken);

      await Promise.all([placeAt(keep, daysAgo(1)), placeAt(cancel, daysAgo(1))]);
      await setStatus(cancel, OrderStatus.CANCELLED);

      const res = await get('/analytics/summary').expect(200);

      expect(res.body.data.revenue.current.amount).toBe(5000);
      expect(res.body.data.orders.current).toBe(1);
    });

    it('drops a returned order from revenue', async () => {
      const productId = await createProduct('Lawn Suit', 5000);
      const orderId = await checkout([{ productId, quantity: 1 }], shopperToken);
      await placeAt(orderId, daysAgo(1));
      await setStatus(orderId, OrderStatus.RETURNED);

      const res = await get('/analytics/summary').expect(200);
      expect(res.body.data.revenue.current.amount).toBe(0);
    });
  });

  describe('summary', () => {
    it('compares against the preceding equal-length period', async () => {
      const productId = await createProduct('Lawn Suit', 1000);

      // Two orders in the last 7 days, one in the 7 before that.
      const recentA = await checkout([{ productId, quantity: 1 }], shopperToken);
      const recentB = await checkout([{ productId, quantity: 1 }], shopperToken);
      const older = await checkout([{ productId, quantity: 1 }], shopperToken);

      await Promise.all([
        placeAt(recentA, daysAgo(1)),
        placeAt(recentB, daysAgo(2)),
        placeAt(older, daysAgo(9)),
      ]);

      const from = daysAgo(7).toISOString();
      const res = await get(`/analytics/summary?from=${from}`).expect(200);

      expect(res.body.data.revenue.current.amount).toBe(2000);
      expect(res.body.data.revenue.previous.amount).toBe(1000);
      expect(res.body.data.revenue.change.amount).toBe(1000);
      expect(res.body.data.revenue.changePercent).toBe(100);
    });

    it('reports no baseline as null, not as Infinity or 100', async () => {
      const productId = await createProduct('Lawn Suit', 1000);
      const orderId = await checkout([{ productId, quantity: 1 }], shopperToken);
      await placeAt(orderId, daysAgo(1));

      const res = await get(`/analytics/summary?from=${daysAgo(7).toISOString()}`).expect(200);

      expect(res.body.data.revenue.previous.amount).toBe(0);
      expect(res.body.data.revenue.changePercent).toBeNull();
    });

    it('returns zeros rather than failing when nothing was sold', async () => {
      const res = await get('/analytics/summary').expect(200);

      expect(res.body.data.revenue.current.amount).toBe(0);
      expect(res.body.data.orders.current).toBe(0);
      expect(res.body.data.averageOrderValue.current.amount).toBe(0);
      expect(res.body.data.unitsSold.current).toBe(0);
    });

    it('averages the order value without tripping Money on a fraction', async () => {
      const productId = await createProduct('Lawn Suit', 1000);
      // Three orders of 1000, 1000 and 1001 average to 1000.33...
      const ids = await Promise.all([
        checkout([{ productId, quantity: 1 }], shopperToken),
        checkout([{ productId, quantity: 1 }], shopperToken),
        checkout([{ productId, quantity: 1 }], shopperToken),
      ]);
      await Promise.all(ids.map((id) => placeAt(id, daysAgo(1))));
      await orderModel.updateOne({ _id: ids[2] }, { $set: { grandTotal: 1001 } });

      const res = await get('/analytics/summary').expect(200);

      expect(res.body.data.averageOrderValue.current.amount).toBe(1000);
      expect(Number.isInteger(res.body.data.averageOrderValue.current.amount)).toBe(true);
    });

    it('counts units without multiplying them by the line count', async () => {
      const first = await createProduct('Lawn Suit', 1000);
      const second = await createProduct('Chiffon Suit', 2000);

      const orderId = await checkout(
        [
          { productId: first, quantity: 2 },
          { productId: second, quantity: 3 },
        ],
        shopperToken,
      );
      await placeAt(orderId, daysAgo(1));

      const res = await get('/analytics/summary').expect(200);

      expect(res.body.data.unitsSold.current).toBe(5);
      // The classic $unwind trap: one order, counted once, not once per line.
      expect(res.body.data.orders.current).toBe(1);
      expect(res.body.data.revenue.current.amount).toBe(2 * 1000 + 3 * 2000);
    });

    it('counts a guest order towards new customers', async () => {
      const productId = await createProduct('Lawn Suit', 1000);
      const orderId = await checkout([{ productId, quantity: 1 }]);
      await placeAt(orderId, daysAgo(1));

      const res = await get('/analytics/summary').expect(200);

      // userId is null on a guest order, so a userId-keyed definition would
      // count this buyer as nobody.
      expect(res.body.data.newCustomers.current).toBe(1);
    });

    it('counts a returning buyer only on their first order', async () => {
      const productId = await createProduct('Lawn Suit', 1000);
      const first = await checkout([{ productId, quantity: 1 }], shopperToken);
      const second = await checkout([{ productId, quantity: 1 }], shopperToken);

      await Promise.all([placeAt(first, daysAgo(40)), placeAt(second, daysAgo(1))]);

      const res = await get('/analytics/summary').expect(200);

      // Their first order was before this window, so they are not new in it.
      expect(res.body.data.orders.current).toBe(1);
      expect(res.body.data.newCustomers.current).toBe(0);
    });
  });

  describe('revenue series', () => {
    it('emits a zero bucket for a day with no orders rather than a hole', async () => {
      const productId = await createProduct('Lawn Suit', 1000);
      const orderId = await checkout([{ productId, quantity: 1 }], shopperToken);
      await placeAt(orderId, daysAgo(3));

      const res = await get(
        `/analytics/revenue-series?from=${daysAgo(6).toISOString()}&interval=day`,
      ).expect(200);

      const buckets = res.body.data.buckets as { revenue: { amount: number } }[];

      expect(buckets.length).toBeGreaterThanOrEqual(7);
      expect(buckets.filter((b) => b.revenue.amount > 0)).toHaveLength(1);
      // Every other day is present at zero — a chart needs the gap drawn.
      expect(buckets.every((b) => typeof b.revenue.amount === 'number')).toBe(true);
    });

    it('sums to the summary revenue over the same period', async () => {
      const productId = await createProduct('Lawn Suit', 1500);
      const ids = await Promise.all([
        checkout([{ productId, quantity: 1 }], shopperToken),
        checkout([{ productId, quantity: 2 }], shopperToken),
      ]);
      await Promise.all([placeAt(ids[0], daysAgo(1)), placeAt(ids[1], daysAgo(5))]);

      const from = daysAgo(10).toISOString();
      const [summary, series] = await Promise.all([
        get(`/analytics/summary?from=${from}`).expect(200),
        get(`/analytics/revenue-series?from=${from}`).expect(200),
      ]);

      const total = (series.body.data.buckets as { revenue: { amount: number } }[]).reduce(
        (sum, bucket) => sum + bucket.revenue.amount,
        0,
      );

      expect(total).toBe(summary.body.data.revenue.current.amount);
    });
  });

  describe('top products', () => {
    it('ranks by units and returns string ids, not raw ObjectIds', async () => {
      const popular = await createProduct('Lawn Suit', 1000);
      const pricey = await createProduct('Bridal Set', 50_000);

      const orderId = await checkout(
        [
          { productId: popular, quantity: 5 },
          { productId: pricey, quantity: 1 },
        ],
        shopperToken,
      );
      await placeAt(orderId, daysAgo(1));

      const res = await get('/analytics/top-products?sort=units').expect(200);
      const items = res.body.data.items as { productId: string; unitsSold: number }[];

      expect(items[0].productId).toBe(popular);
      expect(items[0].unitsSold).toBe(5);
      // Aggregation output bypasses the id transform, so this is a real risk.
      expect(typeof items[0].productId).toBe('string');
    });

    it('ranks by revenue when asked', async () => {
      const popular = await createProduct('Lawn Suit', 1000);
      const pricey = await createProduct('Bridal Set', 50_000);

      const orderId = await checkout(
        [
          { productId: popular, quantity: 5 },
          { productId: pricey, quantity: 1 },
        ],
        shopperToken,
      );
      await placeAt(orderId, daysAgo(1));

      const res = await get('/analytics/top-products?sort=revenue').expect(200);
      expect((res.body.data.items as { productId: string }[])[0].productId).toBe(pricey);
    });

    it('sums exactly to the summary product revenue', async () => {
      const first = await createProduct('Lawn Suit', 1000);
      const second = await createProduct('Chiffon Suit', 2500);

      const ids = await Promise.all([
        checkout([{ productId: first, quantity: 3 }], shopperToken),
        checkout(
          [
            { productId: first, quantity: 1 },
            { productId: second, quantity: 2 },
          ],
          shopperToken,
        ),
      ]);
      await Promise.all(ids.map((id) => placeAt(id, daysAgo(1))));

      const [summary, top] = await Promise.all([
        get('/analytics/summary').expect(200),
        get('/analytics/top-products?limit=50').expect(200),
      ]);

      const total = (top.body.data.items as { productRevenue: { amount: number } }[]).reduce(
        (sum, item) => sum + item.productRevenue.amount,
        0,
      );

      // The invariant that turns "these two numbers disagree" from a support
      // ticket into a test.
      expect(total).toBe(summary.body.data.productRevenue.current.amount);
    });
  });

  describe('sales by category', () => {
    it('attributes revenue to the root category and sums to product revenue', async () => {
      const other = await createCategory(app, adminToken, 'Formals');

      const inFirst = await createProduct('Lawn Suit', 1000);
      const inSecondRes = await request(app.getHttpServer())
        .post(api('/products'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Blazer', price: 4000, stock: 10, categoryId: other })
        .expect(201);
      const inSecond = inSecondRes.body.data.id as string;

      const orderId = await checkout(
        [
          { productId: inFirst, quantity: 2 },
          { productId: inSecond, quantity: 1 },
        ],
        shopperToken,
      );
      await placeAt(orderId, daysAgo(1));

      const [summary, byCategory] = await Promise.all([
        get('/analytics/summary').expect(200),
        get('/analytics/sales-by-category').expect(200),
      ]);

      const items = byCategory.body.data.items as {
        categoryId: string | null;
        productRevenue: { amount: number };
        unitsSold: number;
        productCount: number;
      }[];

      expect(items).toHaveLength(2);
      // Sorted by revenue: the blazer's 4000 beats the suits' 2000.
      expect(items[0].categoryId).toBe(other);
      expect(items[0].productRevenue.amount).toBe(4000);
      expect(items[1].productRevenue.amount).toBe(2000);
      expect(items[1].unitsSold).toBe(2);

      const total = items.reduce((sum, item) => sum + item.productRevenue.amount, 0);
      expect(total).toBe(summary.body.data.productRevenue.current.amount);
    });
  });

  describe('range validation', () => {
    it('refuses a backwards range', async () => {
      await get('/analytics/summary?from=2026-09-07&to=2026-09-01').expect(400);
    });

    it('refuses a window longer than a year', async () => {
      await get('/analytics/summary?from=2020-01-01&to=2026-01-01').expect(400);
    });

    it('refuses an unparseable date', async () => {
      await get('/analytics/summary?from=last-tuesday').expect(400);
    });

    it('includes the whole of a date-only end day', async () => {
      const res = await get('/analytics/summary?from=2026-08-01&to=2026-08-31').expect(200);
      expect(res.body.data.period.to).toBe('2026-09-01T00:00:00.000Z');
    });
  });
});
