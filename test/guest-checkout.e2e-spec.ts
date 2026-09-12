import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { MailerService } from '../src/modules/notifications/mailer.service';
import {
  NotificationLog,
  NotificationLogDocument,
} from '../src/modules/notifications/schemas/notification-log.schema';
import { OrderStatus } from '../src/modules/orders/enums/order-status.enum';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxDispatcher } from '../src/modules/outbox/outbox.dispatcher';
import { OutboxDocument, OutboxMessage } from '../src/modules/outbox/schemas/outbox.schema';
import { PaymentMethod, PaymentStatus } from '../src/modules/payments/enums/payment-status.enum';
import { Payment, PaymentDocument } from '../src/modules/payments/schemas/payment.schema';
import { ShipmentStatus } from '../src/modules/shipping/enums/shipment-status.enum';
import { Shipment, ShipmentDocument } from '../src/modules/shipping/schemas/shipment.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

describe('Guest checkout, two roles, and COD (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let orderModel: Model<OrderDocument>;
  let paymentModel: Model<PaymentDocument>;
  let shipmentModel: Model<ShipmentDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let outboxModel: Model<OutboxDocument>;
  let logModel: Model<NotificationLogDocument>;
  let dispatcher: OutboxDispatcher;
  let mailer: MailerService;
  let sendSpy: jest.SpyInstance;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
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
    paymentModel = app.get<Model<PaymentDocument>>(getModelToken(Payment.name));
    shipmentModel = app.get<Model<ShipmentDocument>>(getModelToken(Shipment.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    logModel = app.get<Model<NotificationLogDocument>>(getModelToken(NotificationLog.name));
    dispatcher = app.get(OutboxDispatcher);
    mailer = app.get(MailerService);
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

  const guestBody = (overrides: Record<string, unknown> = {}) => ({
    email: 'guest@example.com',
    name: 'Guest Shopper',
    shippingAddress: address,
    ...overrides,
  });

  beforeEach(async () => {
    await Promise.all([
      orderModel.deleteMany({}),
      paymentModel.deleteMany({}),
      shipmentModel.deleteMany({}),
      productModel.deleteMany({}),
      userModel.deleteMany({}),
      outboxModel.deleteMany({}),
      logModel.deleteMany({}),
    ]);

    sendSpy = jest.spyOn(mailer, 'send');
    adminToken = (await makeUser('admin@example.com', UserRole.ADMIN)).token;

    // Every product needs a category now.
    const categoryId = await createCategory(app, adminToken);
    const product = await request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Wireless Mouse', price: 2499, stock: 20, categoryId })
      .expect(201);
    productId = product.body.data.id as string;
    sendSpy.mockClear();
  });

  afterEach(() => sendSpy.mockRestore());

  // =================================================================== ROLES

  describe('two roles', () => {
    it('exposes exactly ADMIN and USER', () => {
      expect(Object.values(UserRole).sort()).toEqual(['ADMIN', 'USER']);
    });

    it('rejects any role outside the enum, wherever it could be supplied', async () => {
      // The guard against a third role creeping back in through the API.
      const customer = await makeUser('customer@example.com', UserRole.USER);

      for (const role of ['SUPER_ADMIN', 'MANAGER', 'admin']) {
        await request(app.getHttpServer())
          .patch(api(`/users/${customer.id}/access`))
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ role })
          .expect(400);
      }
    });

    it('lets an admin manage the catalogue and read inventory', async () => {
      // One staff role means one person to grant: the admin owns all of it.
      await request(app.getHttpServer())
        .get(api(`/inventory/products/${productId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(api(`/products/${productId}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Renamed by admin' })
        .expect(200);
    });

    it('keeps a customer out of the dashboard', async () => {
      const customer = await makeUser('customer@example.com', UserRole.USER);

      for (const [method, path, body] of [
        ['post', '/products', { name: 'X', price: 100, stock: 1 }],
        ['get', '/users', undefined],
        ['get', '/ops/queues', undefined],
        ['get', `/inventory/products/${productId}`, undefined],
      ] as [string, string, Record<string, unknown> | undefined][]) {
        const res = await request(app.getHttpServer())
          [method as 'get'](api(path))
          .set('Authorization', `Bearer ${customer.token}`)
          .send(body ?? {});
        expect(res.status).toBe(403);
      }
    });

    it('still refuses to strand the dashboard without an admin', async () => {
      // The seeded admin is the only one; demoting them would lock everyone out.
      const admin = await userModel.findOne({ role: UserRole.ADMIN }).exec();

      const res = await request(app.getHttpServer())
        .patch(api(`/users/${admin!._id.toString()}/access`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.USER });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/last active administrator/i);
    });
  });

  // ============================================================ GUEST ORDERS

  describe('a guest can place an order', () => {
    /** A guest browser: the agent carries the signed guest cookie. */
    const guest = () => request.agent(app.getHttpServer());

    /**
     * The basket comes from the browser, so a guest checkout is a single
     * request. Returned un-awaited so callers can assert on the status.
     */
    const guestCheckout = (
      agent: ReturnType<typeof guest>,
      body: Record<string, unknown> = {},
      quantity = 2,
    ) =>
      agent
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, quantity }], ...guestBody(body) });

    it('places an order with no account at all', async () => {
      const agent = guest();
      const res = await guestCheckout(agent);
      expect(res.status).toBe(201);

      expect(res.body.data.isGuestOrder).toBe(true);
      expect(res.body.data.userId).toBeNull();
      expect(res.body.data.contactEmail).toBe('guest@example.com');
      // Priced from the catalogue, exactly as for a signed-in customer.
      expect(res.body.data.grandTotal.amount).toBe(4998);
      expect(res.body.data.status).toBe(OrderStatus.PENDING);

      // Stock committed in the same transaction as always.
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);

      // And the response minted the identity that lets them come back for it.
      expect(String(res.headers['set-cookie'])).toMatch(/guest_token=/);
      await agent.get(api(`/orders/${res.body.data.id as string}`)).expect(200);
    });

    it('requires an email and a name from a guest', async () => {
      const res = await guest()
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ shippingAddress: address, items: [{ productId, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email address and a name/i);
    });

    it('rejects a malformed guest email at validation', async () => {
      await guest()
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, quantity: 1 }], ...guestBody({ email: 'not-an-email' }) })
        .expect(400);
    });

    it('mints an identity for a guest who has never touched the server', async () => {
      // Checkout is a first-time guest's very first request now, so having no
      // cookie is the normal case rather than an error. The order still needs an
      // owner, so one is minted here — otherwise they could never read back what
      // they just placed.
      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, quantity: 1 }], ...guestBody() })
        .expect(201);

      expect(String(res.headers['set-cookie'])).toMatch(/guest_token=/);
      const stored = await orderModel.findById(res.body.data.id as string).exec();
      expect(stored?.guestToken).toEqual(expect.any(String));
      expect(stored?.userId).toBeNull();
    });

    it('refuses an order with no items', async () => {
      const res = await guest()
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send(guestBody());

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/at least one item/i);
    });

    it('lets the guest read back their own order and list it', async () => {
      const agent = guest();
      const order = await guestCheckout(agent);
      expect(order.status).toBe(201);
      const orderId = order.body.data.id as string;

      await agent.get(api(`/orders/${orderId}`)).expect(200);

      const list = await agent.get(api('/orders')).expect(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0].id).toBe(orderId);
    });

    it("hides a guest's order from everyone else", async () => {
      const first = guest();
      const order = await guestCheckout(first);
      expect(order.status).toBe(201);
      const orderId = order.body.data.id as string;

      // A different browser — a different cookie.
      await guest()
        .get(api(`/orders/${orderId}`))
        .expect(404);

      // No cookie at all.
      await request(app.getHttpServer())
        .get(api(`/orders/${orderId}`))
        .expect(404);

      // A signed-in customer who did not place it.
      const other = await makeUser('other@example.com', UserRole.USER);
      await request(app.getHttpServer())
        .get(api(`/orders/${orderId}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
    });

    it('shows nothing to a browser that has never ordered', async () => {
      expect((await guestCheckout(guest())).status).toBe(201);

      // No filter must never mean "no restriction".
      const res = await request(app.getHttpServer()).get(api('/orders')).expect(200);
      expect(res.body.data.items).toHaveLength(0);
    });

    it('lets an admin see guest orders', async () => {
      expect((await guestCheckout(guest())).status).toBe(201);

      const res = await request(app.getHttpServer())
        .get(api('/orders'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].isGuestOrder).toBe(true);
    });

    it('lets the guest cancel, returning stock', async () => {
      const agent = guest();
      const order = await guestCheckout(agent);
      expect(order.status).toBe(201);
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);

      await agent
        .post(api(`/orders/${order.body.data.id}/cancel`))
        .send({})
        .expect(201);
      expect((await productModel.findById(productId).exec())?.stock).toBe(20);
    });

    it('scopes idempotency per guest, not globally', async () => {
      const key = 'shared-key-value';

      // Neither guest has a cookie yet, so the scope falls back to the request
      // itself. Two different people cannot collide on a shared key value
      // because their details differ.
      await guest()
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send({ items: [{ productId, quantity: 1 }], ...guestBody() })
        .expect(201);

      const res = await guest()
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send({
          items: [{ productId, quantity: 1 }],
          ...guestBody({ email: 'second@example.com' }),
        })
        .expect(201);

      expect(res.body.data.contactEmail).toBe('second@example.com');
      expect(await orderModel.countDocuments({})).toBe(2);
    });

    it('replays a guest key rather than ordering twice', async () => {
      const agent = guest();
      const key = randomUUID();
      const body = { items: [{ productId, quantity: 2 }], ...guestBody() };

      const first = await agent
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const replay = await agent
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await orderModel.countDocuments({})).toBe(1);
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);
    });

    it('creates one order when a first-time guest double-submits', async () => {
      // The riskiest case of the new flow: two concurrent requests, neither
      // carrying a cookie, so neither has an identity to be scoped by. Scoping
      // by the freshly minted token would give them two scopes and two orders.
      const key = randomUUID();
      const body = { items: [{ productId, quantity: 2 }], ...guestBody() };

      const fire = () =>
        request(app.getHttpServer())
          .post(api('/orders/checkout'))
          .set('Idempotency-Key', key)
          .send(body);

      const [a, b] = await Promise.all([fire(), fire()]);

      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      expect(await orderModel.countDocuments({})).toBe(1);
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);
    });

    it('emails the guest their confirmation', async () => {
      expect((await guestCheckout(guest())).status).toBe(201);
      await dispatcher.drain();

      const mails = sendSpy.mock.calls.map((c) => c[0] as { to: string; subject: string });
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toBe('guest@example.com');
      expect(mails[0].subject).toMatch(/We've received your order/);
    });

    it('takes a signed-in customer’s details from their account, not the body', async () => {
      const customer = await makeUser('real@example.com', UserRole.USER);

      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ productId, quantity: 1 }],
          ...guestBody({ email: 'attacker@example.com', name: 'Someone Else' }),
        })
        .expect(201);

      // Supplying contact details must not let a signed-in caller redirect their
      // own confirmations, or impersonate anyone.
      expect(res.body.data.contactEmail).toBe('real@example.com');
      expect(res.body.data.isGuestOrder).toBe(false);
      expect(res.body.data.userId).toBe(customer.id);
    });

    it('prefers the token over a stale guest cookie', async () => {
      // The agent picks up a guest cookie by ordering once as a guest.
      const agent = guest();
      expect((await guestCheckout(agent)).status).toBe(201);

      // Same browser, now signed in: the second order is theirs, not the
      // cookie's, so signing in cannot append to a stranger's order history.
      const customer = await makeUser('signedin@example.com', UserRole.USER);
      const res = await agent
        .post(api('/orders/checkout'))
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ shippingAddress: address, items: [{ productId, quantity: 1 }] })
        .expect(201);

      expect(res.body.data.isGuestOrder).toBe(false);
      expect(res.body.data.userId).toBe(customer.id);
    });
  });

  // ===================================================================== COD

  describe('cash on delivery', () => {
    const guest = () => request.agent(app.getHttpServer());

    const placeGuestOrder = async (agent: ReturnType<typeof guest>) => {
      const res = await agent
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, quantity: 2 }], ...guestBody() })
        .expect(201);
      return res.body.data.id as string;
    };

    it('authorizes rather than pends, because the courier collects later', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      const res = await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);

      expect(res.body.data.method).toBe(PaymentMethod.CASH_ON_DELIVERY);
      expect(res.body.data.status).toBe(PaymentStatus.AUTHORIZED);
      expect(res.body.data.instructions.note).toMatch(/courier/i);
    });

    it('creates a shipment without any money having moved', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
      await dispatcher.drain();

      // The whole point: a COD order that waits for a capture never ships.
      const shipment = await shipmentModel.findOne({ orderId }).exec();
      expect(shipment).not.toBeNull();
      expect(shipment!.status).toBe(ShipmentStatus.PENDING);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.PENDING);
    });

    it('runs the whole COD lifecycle to delivery and collection', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      const payment = await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
      await dispatcher.drain();

      const shipmentId = (await shipmentModel.findOne({ orderId }).exec())!._id.toString();

      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM-COD-1' })
        .expect(201);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.SHIPPED);

      await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.DELIVERED })
        .expect(200);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.DELIVERED);

      // The courier hands the cash in; the capture is recorded afterwards.
      const captured = await request(app.getHttpServer())
        .post(api(`/payments/${payment.body.data.id}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Cash collected on delivery' })
        .expect(201);

      expect(captured.body.data.status).toBe(PaymentStatus.CAPTURED);
      // The order stays DELIVERED: moving it to PAID would be a step backwards.
      // Money lives on the payment record, fulfilment on the order.
      const order = await orderModel.findById(orderId).exec();
      expect(order?.status).toBe(OrderStatus.DELIVERED);
    });

    it('creates exactly one shipment even if confirmation is redelivered', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
      await dispatcher.drain();

      await outboxModel.updateMany(
        { eventType: 'order.confirmed' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      expect(await shipmentModel.countDocuments({ orderId })).toBe(1);
    });

    it('still lets a guest track their COD shipment', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);
      await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
      await dispatcher.drain();

      const res = await agent.get(api(`/shipments/orders/${orderId}`)).expect(200);
      expect(res.body.data.orderId).toBe(orderId);

      // And nobody else can.
      await guest()
        .get(api(`/shipments/orders/${orderId}`))
        .expect(404);
    });

    it('leaves a bank transfer waiting for the money, as before', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      const res = await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.BANK_TRANSFER })
        .expect(201);
      await dispatcher.drain();

      expect(res.body.data.status).toBe(PaymentStatus.PENDING);
      // Prepaid means prepaid: nothing ships until the transfer clears.
      expect(await shipmentModel.countDocuments({ orderId })).toBe(0);
    });

    it('lets a guest pay for their own order and nobody else’s', async () => {
      const agent = guest();
      const orderId = await placeGuestOrder(agent);

      await guest()
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(404);

      await agent
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
    });
  });
});
