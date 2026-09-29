import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Suit, SuitDocument } from '../src/modules/erp/schemas/suit.schema';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { OrderStatus } from '../src/modules/orders/enums/order-status.enum';
import { IdempotencyKey } from '../src/modules/orders/schemas/idempotency-key.schema';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxMessage, OutboxDocument } from '../src/modules/outbox/schemas/outbox.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createSuit, createTestApp } from './setup-app';

describe('Orders & Checkout (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let orderModel: Model<OrderDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let outboxModel: Model<OutboxDocument>;
  let keyModel: Model<{ key: string }>;

  const password = 'StrongP@ssw0rd!';
  let shopperToken: string;
  let shopperId: string;
  let adminToken: string;
  let categoryId: string;
  let productId: string;

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
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    keyModel = app.get<Model<{ key: string }>>(getModelToken(IdempotencyKey.name));
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

  /** The colour each product was created in, so a basket line can name it. */
  const colours = new Map<string, string>();

  /** A product in one colour — a fresh suit of `stock` units — sold unstitched at `price`. */
  const createProduct = async ({
    price = 2499,
    stock = 10,
    ...overrides
  }: Record<string, unknown> = {}) => {
    const res = await request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Wireless Mouse',
        categoryId,
        offers: [{ sizing: 'UNSTITCHED', price }],
        variants: [{ erpId: await createSuit(app, stock as number), color: 'Red' }],
        ...overrides,
      })
      .expect(201);
    colours.set(res.body.data.id as string, res.body.data.variants[0].id as string);
    return res.body.data.id as string;
  };

  /** A basket line: the product, in the colour it was created in. */
  const line = (productId: string, quantity: unknown) => ({
    productId,
    variantId: colours.get(productId),
    quantity,
  });

  /** A branch sells the last units of a product's colour, in the ERP. */
  const sellOutInErp = async (productId: string) => {
    const product = await productModel.findById(productId).lean().exec();
    await app
      .get<Model<SuitDocument>>(getModelToken(Suit.name))
      .collection.updateOne(
        { _id: new Types.ObjectId(product!.variants[0].erpId) },
        { $set: { quantity: 0 } },
      );
  };

  /**
   * The basket lives in the browser now, so the spec keeps one per shopper and
   * sends it at checkout. `addLine` is what a storefront "add" click amounts to
   * now: it touches no server state at all.
   */
  const baskets = new Map<string, ReturnType<typeof line>[]>();

  const addLine = (token: string, productId: string, quantity: number) => {
    baskets.set(token, [...(baskets.get(token) ?? []), line(productId, quantity)]);
  };

  const checkout = (
    token: string,
    body: Record<string, unknown> = {},
    key: string = randomUUID(),
  ) =>
    request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ shippingAddress: address, items: baskets.get(token) ?? [], ...body });

  beforeEach(async () => {
    baskets.clear();
    colours.clear();
    await Promise.all([
      orderModel.deleteMany({}),
      productModel.deleteMany({}),
      userModel.deleteMany({}),
      outboxModel.deleteMany({}),
      keyModel.deleteMany({}),
    ]);

    const shopper = await makeUser('shopper@example.com', UserRole.USER);
    shopperToken = shopper.token;
    shopperId = shopper.id;
    adminToken = (await makeUser('admin@example.com', UserRole.ADMIN)).token;
    categoryId = await createCategory(app, adminToken);
    productId = await createProduct();
  });

  // ------------------------------------------------------------------- C4

  describe('prices come from the catalogue (C4)', () => {
    it('ignores totals and prices supplied by the client', async () => {
      addLine(shopperToken, productId, 2);

      // The old CreateOrderDto accepted totalPrice and per-item unitPrice from
      // the body and never checked them, so anything could be bought for a penny.
      // Here those keys are not on the DTO at all.
      const res = await checkout(shopperToken, {
        totalPrice: 1,
        grandTotal: 1,
        items: [{ ...line(productId, 2), unitPrice: 1, price: 1 }],
      });

      expect(res.status).toBe(400);
    });

    it('charges the catalogue price, not whatever the client sends', async () => {
      addLine(shopperToken, productId, 3);

      // Price changes between the browser building the basket and checkout.
      await request(app.getHttpServer())
        .patch(api(`/products/${productId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ offers: [{ sizing: 'UNSTITCHED', price: 1999 }] })
        .expect(200);

      const res = await checkout(shopperToken).expect(201);

      expect(res.body.data.items[0].unitPrice.amount).toBe(1999);
      expect(res.body.data.items[0].lineTotal.amount).toBe(5997);
      expect(res.body.data.subtotal.amount).toBe(5997);
      expect(res.body.data.grandTotal.amount).toBe(5997);
    });

    it('computes multi-line totals exactly', async () => {
      const second = await createProduct({ name: 'Keyboard', price: 7990, stock: 5 });
      addLine(shopperToken, productId, 3);
      addLine(shopperToken, second, 2);

      const res = await checkout(shopperToken).expect(201);

      expect(res.body.data.subtotal.amount).toBe(2499 * 3 + 7990 * 2);
      expect(res.body.data.grandTotal.formatted).toBe('$234.77');
    });
  });

  describe('the basket arrives from the browser', () => {
    it('accepts only what was chosen, and how many, per line', async () => {
      // The whole surface the client controls. Anything that could influence
      // what is charged is an unknown key, and `forbidNonWhitelisted` rejects it
      // rather than ignoring it — a silent strip would look like it worked.
      for (const item of [
        { ...line(productId, 1), unitPrice: 1 },
        { ...line(productId, 1), price: 1 },
        { ...line(productId, 1), lineTotal: 1 },
        { ...line(productId, 1), name: 'Free stuff' },
        { ...line(productId, 1), color: 'Free' },
      ]) {
        await checkout(shopperToken, { items: [item] }).expect(400);
      }

      expect(await orderModel.countDocuments({})).toBe(0);
    });

    it('folds a repeated product into one line', async () => {
      // Two tabs, or a UI that appends rather than increments. An order with
      // the same product on two lines reads as a bug to whoever opens it.
      const res = await checkout(shopperToken, {
        items: [line(productId, 2), line(productId, 3)],
      }).expect(201);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].quantity).toBe(5);
      expect(res.body.data.grandTotal.amount).toBe(2499 * 5);
      expect((await productModel.findById(productId).exec())?.stock).toBe(5);
    });

    it('applies the per-line cap to the folded total', async () => {
      // Otherwise splitting one line into two would be a way around it.
      await checkout(shopperToken, {
        items: [line(productId, 600), line(productId, 600)],
      }).expect(400);
      await checkout(shopperToken, { items: [line(productId, 1000)] }).expect(400);
    });

    it('rejects a nonsensical quantity', async () => {
      for (const quantity of [0, -1, 1.5, '2']) {
        await checkout(shopperToken, { items: [line(productId, quantity)] }).expect(400);
      }
    });

    it('rejects a basket that is empty, oversized, or malformed', async () => {
      await checkout(shopperToken, { items: [] }).expect(400);
      await checkout(shopperToken, { items: 'everything' }).expect(400);
      await checkout(shopperToken, {
        items: Array.from({ length: 101 }, () => line(productId, 1)),
      }).expect(400);
    });

    it('rejects a product that does not exist', async () => {
      const res = await checkout(shopperToken, {
        items: [
          {
            productId: '0123456789abcdef01234567',
            variantId: '0123456789abcdef01234568',
            quantity: 1,
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no longer available/i);
      expect(await orderModel.countDocuments({})).toBe(0);
    });

    it('prices every line from the catalogue, whatever the browser believed', async () => {
      const second = await createProduct({ name: 'Keyboard', price: 7990, stock: 5 });

      const res = await checkout(shopperToken, {
        items: [line(productId, 2), line(second, 1)],
      }).expect(201);

      expect(res.body.data.subtotal.amount).toBe(2499 * 2 + 7990);
    });
  });

  // ------------------------------------------------------------------- C5

  describe('the customer comes from the token (C5)', () => {
    it('ignores a userId in the body', async () => {
      addLine(shopperToken, productId, 1);
      const other = await makeUser('victim@example.com', UserRole.USER);

      // `userId` is not on CheckoutDto, so forbidNonWhitelisted rejects it
      // outright rather than quietly attributing the order to someone else.
      await checkout(shopperToken, { userId: other.id }).expect(400);
    });

    it('attributes the order to the authenticated customer', async () => {
      addLine(shopperToken, productId, 1);
      const res = await checkout(shopperToken).expect(201);
      expect(res.body.data.userId).toBe(shopperId);
    });
  });

  // ------------------------------------------------------------------- A5

  describe('checkout is one transaction (A5, A3)', () => {
    it('commits the order and the stock together', async () => {
      addLine(shopperToken, productId, 4);

      const res = await checkout(shopperToken).expect(201);

      // Order written…
      expect(res.body.data.status).toBe(OrderStatus.PENDING);
      // …and stock committed, in the same transaction.
      expect((await productModel.findById(productId).exec())?.stock).toBe(6);
    });

    it('rolls everything back when a line has insufficient stock', async () => {
      const scarce = await createProduct({ name: 'Scarce', price: 5000, stock: 1 });
      addLine(shopperToken, productId, 2);
      addLine(shopperToken, scarce, 1);

      // Someone else buys the last scarce unit first.
      await sellOutInErp(scarce);

      const res = await checkout(shopperToken);
      expect(res.status).toBe(409);

      // No order and no partial stock consumption — the whole point of the
      // transaction. The old flow could consume stock for an order that was
      // never created. The first line's stock must be untouched even though its
      // decrement ran before the failing one.
      expect(await orderModel.countDocuments({})).toBe(0);
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);
    });

    it('rolls back when a product is withdrawn mid-flight', async () => {
      addLine(shopperToken, productId, 2);
      await productModel.updateOne({ _id: productId }, { $set: { isActive: false } });

      const res = await checkout(shopperToken);
      expect(res.status).toBe(400);
      expect(await orderModel.countDocuments({})).toBe(0);
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);
    });

    it('shows the reduced stock immediately, not a cached pre-sale figure', async () => {
      // Prime the catalogue cache before the sale.
      const before = await request(app.getHttpServer())
        .get(api(`/products/${productId}`))
        .expect(200);
      expect(before.body.data.stock).toBe(10);

      addLine(shopperToken, productId, 3);
      await checkout(shopperToken).expect(201);

      // Inventory writes Product.stock directly, bypassing ProductsService, so
      // nothing else would retire the cached copy — the storefront would keep
      // advertising units that had already been sold.
      const after = await request(app.getHttpServer())
        .get(api(`/products/${productId}`))
        .expect(200);
      expect(after.body.data.stock).toBe(7);

      const listed = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(listed.body.data.items[0].stock).toBe(7);
    });

    it('shows restored stock immediately after a cancellation', async () => {
      addLine(shopperToken, productId, 4);
      const order = await checkout(shopperToken).expect(201);

      await request(app.getHttpServer())
        .get(api(`/products/${productId}`))
        .expect(200);

      await request(app.getHttpServer())
        .post(api(`/orders/${order.body.data.id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(api(`/products/${productId}`))
        .expect(200);
      expect(after.body.data.stock).toBe(10);
    });

    it('rejects an order with no items', async () => {
      const res = await checkout(shopperToken);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/at least one item/i);
    });
  });

  // ------------------------------------------------------------------- A1

  describe('stock cannot be oversold at checkout (A1)', () => {
    it('lets exactly the available quantity through under concurrency', async () => {
      const limited = await createProduct({ name: 'Limited', price: 1000, stock: 5 });

      // Five shoppers, each wanting 2 units, against 5 units of stock.
      const shoppers = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => makeUser(`buyer${n}@example.com`, UserRole.USER)),
      );
      for (const s of shoppers) addLine(s.token, limited, 2);

      const results = await Promise.all(shoppers.map((s) => checkout(s.token)));

      const created = results.filter((r) => r.status === 201).length;
      const rejected = results.filter((r) => r.status === 409).length;

      // 5 units / 2 per order = 2 orders can be satisfied.
      expect(created).toBe(2);
      expect(rejected).toBe(3);

      const after = await productModel.findById(limited).exec();
      expect(after?.stock).toBe(1);
      expect(after?.stock).toBeGreaterThanOrEqual(0);
      expect(await orderModel.countDocuments({})).toBe(2);
    });
  });

  describe('idempotency', () => {
    it('requires an Idempotency-Key', async () => {
      addLine(shopperToken, productId, 1);

      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ shippingAddress: address, items: [line(productId, 1)] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Idempotency-Key/i);
    });

    it('returns the first order when the same key is replayed', async () => {
      addLine(shopperToken, productId, 2);
      const key = randomUUID();

      const first = await checkout(shopperToken, {}, key).expect(201);
      const replay = await checkout(shopperToken, {}, key).expect(201);

      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(replay.body.data.orderNumber).toBe(first.body.data.orderNumber);

      // One order, one stock decrement — not two.
      expect(await orderModel.countDocuments({})).toBe(1);
      expect((await productModel.findById(productId).exec())?.stock).toBe(8);
    });

    it('creates only one order when the same key arrives concurrently', async () => {
      addLine(shopperToken, productId, 2);
      const key = randomUUID();

      const [a, b] = await Promise.all([
        checkout(shopperToken, {}, key),
        checkout(shopperToken, {}, key),
      ]);

      // One wins; the other either replays the result or is told it is in
      // flight. Never two orders.
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      expect(await orderModel.countDocuments({})).toBe(1);
      expect((await productModel.findById(productId).exec())?.stock).toBe(8);
    });

    it('rejects a key reused with a different body', async () => {
      addLine(shopperToken, productId, 1);
      const key = randomUUID();

      await checkout(shopperToken, {}, key).expect(201);
      addLine(shopperToken, productId, 1);

      const res = await checkout(shopperToken, { customerNote: 'different' }, key);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/different request body/i);
    });

    it('releases the key after a failure so the customer can retry', async () => {
      const key = randomUUID();
      addLine(shopperToken, productId, 20);

      // Fails: more units than exist.
      await checkout(shopperToken, {}, key).expect(409);

      // Same key now works, rather than being locked out for 24 hours.
      baskets.set(shopperToken, [line(productId, 1)]);
      await checkout(shopperToken, {}, key).expect(201);
    });

    it('scopes keys per customer', async () => {
      const other = await makeUser('other@example.com', UserRole.USER);
      const key = 'shared-key-value';

      addLine(shopperToken, productId, 1);
      addLine(other.token, productId, 1);

      await checkout(shopperToken, {}, key).expect(201);
      // A different customer using the same key value must not collide.
      await checkout(other.token, {}, key).expect(201);

      expect(await orderModel.countDocuments({})).toBe(2);
    });
  });

  describe('outbox', () => {
    it('records order.placed in the same transaction', async () => {
      addLine(shopperToken, productId, 2);
      const res = await checkout(shopperToken).expect(201);

      const messages = await outboxModel.find({ eventType: 'order.placed' }).exec();
      expect(messages).toHaveLength(1);
      expect(messages[0].aggregateId.toString()).toBe(res.body.data.id);
      expect(messages[0].status).toBe('PENDING');
      expect(messages[0].payload.orderNumber).toBe(res.body.data.orderNumber);
    });

    it('writes no message when checkout fails', async () => {
      addLine(shopperToken, productId, 2);
      await sellOutInErp(productId);

      await checkout(shopperToken).expect(409);

      // The message would have committed with the order; neither did.
      expect(await outboxModel.countDocuments({})).toBe(0);
    });
  });

  // --------------------------------------------------------------- B1 / C3

  describe('status transitions (B1, C3)', () => {
    const placeOrder = async () => {
      addLine(shopperToken, productId, 2);
      const res = await checkout(shopperToken).expect(201);
      return res.body.data.id as string;
    };

    it('rejects an unauthenticated status change', async () => {
      const id = await placeOrder();
      // The old PATCH /orders/:id had no JwtAuthGuard and its guard fell through
      // to `return true` for PATCH — anonymous callers could mutate any order.
      await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .send({ status: OrderStatus.DELIVERED })
        .expect(401);
    });

    it('rejects a customer changing their own order’s status', async () => {
      const id = await placeOrder();
      await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ status: OrderStatus.DELIVERED })
        .expect(403);
    });

    it('lets an admin move an order along a legal edge', async () => {
      const id = await placeOrder();

      // The old update was unreachable anyway: the gateway sent
      // `{ id, updateOrderDto }` while the handler destructured `{ id, order }`.
      const res = await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.PAID, note: 'Payment received' })
        .expect(200);

      expect(res.body.data.status).toBe(OrderStatus.PAID);
      expect(res.body.data.paidAt).not.toBeNull();
      expect(res.body.data.statusHistory).toHaveLength(2);
      expect(res.body.data.statusHistory[1].note).toBe('Payment received');
    });

    it('refuses an illegal jump', async () => {
      const id = await placeOrder();

      const res = await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.DELIVERED });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
      expect((await orderModel.findById(id).exec())?.status).toBe(OrderStatus.PENDING);
    });

    it('refuses to move out of a terminal state', async () => {
      const id = await placeOrder();

      await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.PAID })
        .expect(409);
    });

    it('walks the full happy path', async () => {
      const id = await placeOrder();
      const advance = (status: OrderStatus) =>
        request(app.getHttpServer())
          .patch(api(`/orders/${id}/status`))
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status })
          .expect(200);

      await advance(OrderStatus.PAID);
      await advance(OrderStatus.FULFILLING);
      await advance(OrderStatus.SHIPPED);
      const done = await advance(OrderStatus.DELIVERED);

      expect(done.body.data.status).toBe(OrderStatus.DELIVERED);
      expect(done.body.data.statusHistory).toHaveLength(5);
      // Stock stays committed through the whole path.
      expect((await productModel.findById(productId).exec())?.stock).toBe(8);
    });
  });

  describe('cancellation returns stock (B3)', () => {
    const placeOrder = async () => {
      addLine(shopperToken, productId, 3);
      const res = await checkout(shopperToken).expect(201);
      return res.body.data.id as string;
    };

    it('still closes an order whose product has since been deleted', async () => {
      // A retired product used to make its orders impossible to end: restocking
      // resolves stock through the product document, and a soft-deleted one
      // threw a 404 that failed the whole cancellation. An order must always be
      // able to reach a terminal status.
      const id = await placeOrder();
      await productModel.updateOne({ _id: productId }, { $set: { deletedAt: new Date() } });

      const res = await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ reason: 'Product withdrawn' })
        .expect(201);

      expect(res.body.data.status).toBe(OrderStatus.CANCELLED);
      const order = await orderModel.findById(id).exec();
      expect(order?.stockReleased).toBe(true);
    });

    it('restores the lines it still can when only one product was deleted', async () => {
      const secondId = await createProduct({ name: 'Second Piece', price: 1500 });

      addLine(shopperToken, productId, 3);
      addLine(shopperToken, secondId, 2);
      const id = (await checkout(shopperToken).expect(201)).body.data.id as string;

      await productModel.updateOne({ _id: productId }, { $set: { deletedAt: new Date() } });

      await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      // The surviving line goes back on the shelf; the deleted one cannot.
      expect((await productModel.findById(secondId).exec())?.stock).toBe(10);
    });

    it('lets a customer cancel while the warehouse is still picking', async () => {
      const id = await placeOrder();
      await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.FULFILLING })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      expect(res.body.data.status).toBe(OrderStatus.CANCELLED);
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);
    });

    it('restores stock when a customer cancels', async () => {
      const id = await placeOrder();
      expect((await productModel.findById(productId).exec())?.stock).toBe(7);

      const res = await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ reason: 'Changed my mind' })
        .expect(201);

      expect(res.body.data.status).toBe(OrderStatus.CANCELLED);
      // The old DELETE removed the row and never returned the stock.
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);
    });

    it('is idempotent, and does not restock twice', async () => {
      const id = await placeOrder();

      await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      // Cancelling an already-cancelled order succeeds: the caller asked for it
      // to be cancelled and it is.
      const again = await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      expect(again.body.data.status).toBe(OrderStatus.CANCELLED);
      // One entry, not two — the repeat is a no-op, not a second transition.
      expect(again.body.data.statusHistory).toHaveLength(2);
      // And critically, stock went back exactly once.
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);
    });

    it('stops a customer cancelling once it has shipped', async () => {
      const id = await placeOrder();

      for (const status of [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.SHIPPED]) {
        await request(app.getHttpServer())
          .patch(api(`/orders/${id}/status`))
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status })
          .expect(200);
      }

      const res = await request(app.getHttpServer())
        .post(api(`/orders/${id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/contact support/i);
    });

    it('restores stock when a delivered order is returned', async () => {
      const id = await placeOrder();
      for (const status of [
        OrderStatus.PAID,
        OrderStatus.FULFILLING,
        OrderStatus.SHIPPED,
        OrderStatus.DELIVERED,
      ]) {
        await request(app.getHttpServer())
          .patch(api(`/orders/${id}/status`))
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ status })
          .expect(200);
      }

      await request(app.getHttpServer())
        .patch(api(`/orders/${id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.RETURNED })
        .expect(200);

      // The goods came back, so the units are sellable again. This used to
      // assert 7 — stock stayed consumed — which left a returned parcel
      // unsellable forever.
      expect((await productModel.findById(productId).exec())?.stock).toBe(10);

      const order = await orderModel.findById(id).exec();
      expect(order?.stockReleased).toBe(true);
      expect(order?.returnedAt).toBeTruthy();
    });
  });

  describe('visibility', () => {
    it('shows a customer only their own orders', async () => {
      addLine(shopperToken, productId, 1);
      await checkout(shopperToken).expect(201);

      const other = await makeUser('nosy@example.com', UserRole.USER);
      const res = await request(app.getHttpServer())
        .get(api('/orders'))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(0);
    });

    it('ignores a userId filter from a customer', async () => {
      addLine(shopperToken, productId, 1);
      await checkout(shopperToken).expect(201);

      const other = await makeUser('nosy2@example.com', UserRole.USER);
      const res = await request(app.getHttpServer())
        .get(api(`/orders?userId=${shopperId}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(0);
    });

    it("404s rather than 403s on someone else's order", async () => {
      addLine(shopperToken, productId, 1);
      const order = await checkout(shopperToken).expect(201);
      const other = await makeUser('nosy3@example.com', UserRole.USER);

      // 403 would confirm the id exists.
      await request(app.getHttpServer())
        .get(api(`/orders/${order.body.data.id}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
    });

    it('lets an admin see and filter every order', async () => {
      addLine(shopperToken, productId, 1);
      await checkout(shopperToken).expect(201);

      const all = await request(app.getHttpServer())
        .get(api('/orders'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(all.body.data.items).toHaveLength(1);

      const filtered = await request(app.getHttpServer())
        .get(api(`/orders?userId=${shopperId}&status=PENDING`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(filtered.body.data.items).toHaveLength(1);
    });

    it('refuses to list anything for a caller with no token', async () => {
      addLine(shopperToken, productId, 1);
      await checkout(shopperToken).expect(201);

      // The listing is built from the token, so there is nothing sensible to
      // show a caller without one. A guest looks their order up by its number
      // instead, one at a time.
      await request(app.getHttpServer()).get(api('/orders')).expect(401);
    });

    it('rejects an unlisted sort field', async () => {
      await request(app.getHttpServer())
        .get(api('/orders?sort=grandTotal'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .get(api('/orders?sort=userId'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(400);
    });
  });

  describe('order records', () => {
    it('snapshots the name, colour and price, so later catalogue edits do not rewrite history', async () => {
      addLine(shopperToken, productId, 2);
      const order = await checkout(shopperToken).expect(201);
      const stored = await productModel.findById(productId).lean().exec();

      await request(app.getHttpServer())
        .patch(api(`/products/${productId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Renamed Product',
          offers: [{ sizing: 'UNSTITCHED', price: 9999 }],
          variants: [{ erpId: stored!.variants[0].erpId, color: 'Crimson' }],
        })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(api(`/orders/${order.body.data.id}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      // Unlike the live catalogue, an order records what was charged.
      expect(res.body.data.items[0].name).toBe('Wireless Mouse');
      expect(res.body.data.items[0].color).toBe('Red');
      expect(res.body.data.items[0].variantId).toBe(colours.get(productId));
      expect(res.body.data.items[0].unitPrice.amount).toBe(2499);
    });

    it('survives the product being deleted afterwards', async () => {
      addLine(shopperToken, productId, 1);
      const order = await checkout(shopperToken).expect(201);

      await request(app.getHttpServer())
        .delete(api(`/products/${productId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(api(`/orders/${order.body.data.id}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      expect(res.body.data.items[0].name).toBe('Wireless Mouse');
    });

    it('generates a unique, non-sequential order number', async () => {
      addLine(shopperToken, productId, 1);
      const first = await checkout(shopperToken).expect(201);
      addLine(shopperToken, productId, 1);
      const second = await checkout(shopperToken).expect(201);

      expect(first.body.data.orderNumber).toMatch(/^ORD-\d{8}-[0-9A-F]{8}$/);
      expect(first.body.data.orderNumber).not.toBe(second.body.data.orderNumber);
    });

    it('requires a valid shipping address', async () => {
      addLine(shopperToken, productId, 1);

      await checkout(shopperToken, { shippingAddress: { fullName: 'Jane' } }).expect(400);
      await checkout(shopperToken, {
        shippingAddress: { ...address, country: 'NOT-A-COUNTRY' },
      }).expect(400);
    });

    it('defaults the billing address to the shipping address', async () => {
      addLine(shopperToken, productId, 1);
      const res = await checkout(shopperToken).expect(201);
      expect(res.body.data.billingAddress.line1).toBe(address.line1);
    });
  });
});
