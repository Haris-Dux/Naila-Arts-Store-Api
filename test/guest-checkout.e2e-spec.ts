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
import { TestContext, api, createCategory, createSuit, createTestApp } from './setup-app';

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
  let variantId: string;

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
      .send({
        name: 'Wireless Mouse',
        categoryId,
        offers: [{ sizing: 'UNSTITCHED', price: 2499 }],
        variants: [{ erpId: await createSuit(app, 20), color: 'Red' }],
      })
      .expect(201);
    productId = product.body.data.id as string;
    variantId = product.body.data.variants[0].id as string;
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
    /**
     * The basket comes from the browser, so a guest checkout is a single
     * request. Returned un-awaited so callers can assert on the status.
     */
    const guestCheckout = (body: Record<string, unknown> = {}, quantity = 2) =>
      request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, variantId, quantity }], ...guestBody(body) });

    const lookup = (orderNumber: string) =>
      request(app.getHttpServer()).get(api('/orders/lookup')).query({ orderNumber });

    it('places an order with no account at all', async () => {
      const res = await guestCheckout();
      expect(res.status).toBe(201);

      expect(res.body.data.isGuestOrder).toBe(true);
      expect(res.body.data.userId).toBeNull();
      expect(res.body.data.contactEmail).toBe('guest@example.com');
      // Priced from the catalogue, exactly as for a signed-in customer.
      expect(res.body.data.grandTotal.amount).toBe(4998);
      expect(res.body.data.status).toBe(OrderStatus.PENDING);

      // Stock committed in the same transaction as always.
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);

      // Nothing is minted for them: the order number is the whole handle.
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body.data.orderNumber).toMatch(/^ORD-\d{8}-[0-9A-F]{8}$/);
    });

    it('stores a guest order with no owner at all', async () => {
      const res = await guestCheckout({}, 1);
      expect(res.status).toBe(201);

      const stored = await orderModel.findById(res.body.data.id as string).exec();
      expect(stored?.userId).toBeNull();
    });

    it('requires an email and a name from a guest', async () => {
      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ shippingAddress: address, items: [{ productId, variantId, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email address and a name/i);
    });

    it('rejects a malformed guest email at validation', async () => {
      await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ productId, variantId, quantity: 1 }],
          ...guestBody({ email: 'not-an-email' }),
        })
        .expect(400);
    });

    it('refuses an order with no items', async () => {
      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send(guestBody());

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/at least one item/i);
    });

    it('lets the guest track the order by its number, from anywhere', async () => {
      const order = await guestCheckout();
      expect(order.status).toBe(201);

      const res = await lookup(order.body.data.orderNumber as string).expect(200);

      expect(res.body.data.orderNumber).toBe(order.body.data.orderNumber);
      expect(res.body.data.status).toBe(OrderStatus.PENDING);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.grandTotal.amount).toBe(4998);
      // Nothing has happened to it yet.
      expect(res.body.data.payment).toBeNull();
      expect(res.body.data.shipment).toBeNull();
    });

    it('matches an order number the customer typed in lower case', async () => {
      const order = await guestCheckout();
      expect(order.status).toBe(201);

      const typed = (order.body.data.orderNumber as string).toLowerCase();
      await lookup(typed).expect(200);
    });

    it('withholds the customer’s contact details from the tracking view', async () => {
      const order = await guestCheckout({ customerNote: 'Leave with the neighbour' });
      expect(order.status).toBe(201);

      const res = await lookup(order.body.data.orderNumber as string).expect(200);

      // An order number rides on parcels and receipts, so it identifies an order
      // without proving who is asking. The view is built for that: enough to
      // recognise the order, nothing a stranger could use.
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/guest@example\.com/);
      expect(body).not.toMatch(/12 Market Street/);
      expect(body).not.toMatch(/M1 1AA/);
      expect(body).not.toMatch(/neighbour/i);
      expect(res.body.data.contactEmail).toBeUndefined();
      expect(res.body.data.shippingAddress).toBeUndefined();

      // What it does carry: a shortened name and the destination city.
      expect(res.body.data.recipient).toBe('Jane D.');
      expect(res.body.data.destination).toBe('Manchester, GB');
    });

    it('404s an order number that does not exist', async () => {
      await lookup('ORD-20260101-DEADBEEF').expect(404);
    });

    it('needs a token to reach the order itself', async () => {
      const order = await guestCheckout();
      expect(order.status).toBe(201);
      const orderId = order.body.data.id as string;

      // The full order — addresses, contact details, status notes — is for the
      // customer who owns it and for staff. Guests get the tracking view.
      await request(app.getHttpServer())
        .get(api(`/orders/${orderId}`))
        .expect(401);

      await request(app.getHttpServer()).get(api('/orders')).expect(401);

      const other = await makeUser('other@example.com', UserRole.USER);
      await request(app.getHttpServer())
        .get(api(`/orders/${orderId}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
    });

    it('lets an admin see guest orders', async () => {
      expect((await guestCheckout()).status).toBe(201);

      const res = await request(app.getHttpServer())
        .get(api('/orders'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].isGuestOrder).toBe(true);
    });

    it('leaves cancelling a guest order to staff, who return the stock', async () => {
      const order = await guestCheckout();
      expect(order.status).toBe(201);
      const orderId = order.body.data.id as string;
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);

      // Nobody can cancel on the strength of an order number: a parcel label
      // would be enough to empty somebody else's order.
      await request(app.getHttpServer())
        .post(api(`/orders/${orderId}/cancel`))
        .send({})
        .expect(401);
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);

      await request(app.getHttpServer())
        .post(api(`/orders/${orderId}/cancel`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201);
      expect((await productModel.findById(productId).exec())?.stock).toBe(20);

      const tracked = await lookup(order.body.data.orderNumber as string).expect(200);
      expect(tracked.body.data.status).toBe(OrderStatus.CANCELLED);
    });

    it('scopes idempotency per guest, not globally', async () => {
      const key = 'shared-key-value';

      // A guest has no identity to scope by, so the scope falls back to the
      // request itself. Two different people cannot collide on a shared key
      // value because their details differ.
      await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send({ items: [{ productId, variantId, quantity: 1 }], ...guestBody() })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send({
          items: [{ productId, variantId, quantity: 1 }],
          ...guestBody({ email: 'second@example.com' }),
        })
        .expect(201);

      expect(res.body.data.contactEmail).toBe('second@example.com');
      expect(await orderModel.countDocuments({})).toBe(2);
    });

    it('replays a guest key rather than ordering twice', async () => {
      const key = randomUUID();
      const body = { items: [{ productId, variantId, quantity: 2 }], ...guestBody() };

      const first = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await orderModel.countDocuments({})).toBe(1);
      expect((await productModel.findById(productId).exec())?.stock).toBe(18);
    });

    it('creates one order when a first-time guest double-submits', async () => {
      // Two concurrent requests, neither carrying any identity, so the body is
      // all there is to scope them by.
      const key = randomUUID();
      const body = { items: [{ productId, variantId, quantity: 2 }], ...guestBody() };

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
      expect((await guestCheckout()).status).toBe(201);
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
          items: [{ productId, variantId, quantity: 1 }],
          ...guestBody({ email: 'attacker@example.com', name: 'Someone Else' }),
        })
        .expect(201);

      // Supplying contact details must not let a signed-in caller redirect their
      // own confirmations, or impersonate anyone.
      expect(res.body.data.contactEmail).toBe('real@example.com');
      expect(res.body.data.isGuestOrder).toBe(false);
      expect(res.body.data.userId).toBe(customer.id);
    });
  });

  // ===================================================================== COD

  describe('cash on delivery', () => {
    const placeGuestOrder = async () => {
      const res = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ productId, variantId, quantity: 2 }], ...guestBody() })
        .expect(201);
      return {
        id: res.body.data.id as string,
        orderNumber: res.body.data.orderNumber as string,
      };
    };

    const pay = (orderId: string) =>
      request(app.getHttpServer())
        .post(api('/payments'))
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY });

    it('authorizes rather than pends, because the courier collects later', async () => {
      const order = await placeGuestOrder();

      const res = await pay(order.id).expect(201);

      expect(res.body.data.method).toBe(PaymentMethod.CASH_ON_DELIVERY);
      expect(res.body.data.status).toBe(PaymentStatus.AUTHORIZED);
      expect(res.body.data.instructions.note).toMatch(/courier/i);
    });

    it('creates a shipment without any money having moved', async () => {
      const order = await placeGuestOrder();

      await pay(order.id).expect(201);
      await dispatcher.drain();

      // The whole point: a COD order that waits for a capture never ships.
      const shipment = await shipmentModel.findOne({ orderId: order.id }).exec();
      expect(shipment).not.toBeNull();
      expect(shipment!.status).toBe(ShipmentStatus.PENDING);
      expect((await orderModel.findById(order.id).exec())?.status).toBe(OrderStatus.PENDING);
    });

    it('runs the whole COD lifecycle to delivery and collection', async () => {
      const order = await placeGuestOrder();

      const payment = await pay(order.id).expect(201);
      await dispatcher.drain();

      const shipmentId = (await shipmentModel
        .findOne({ orderId: order.id })
        .exec())!._id.toString();

      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM-COD-1' })
        .expect(201);
      expect((await orderModel.findById(order.id).exec())?.status).toBe(OrderStatus.SHIPPED);

      await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.DELIVERED })
        .expect(200);
      expect((await orderModel.findById(order.id).exec())?.status).toBe(OrderStatus.DELIVERED);

      // The courier hands the cash in; the capture is recorded afterwards.
      const captured = await request(app.getHttpServer())
        .post(api(`/payments/${payment.body.data.id}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Cash collected on delivery' })
        .expect(201);

      expect(captured.body.data.status).toBe(PaymentStatus.CAPTURED);
      // The order stays DELIVERED: moving it to PAID would be a step backwards.
      // Money lives on the payment record, fulfilment on the order.
      const settled = await orderModel.findById(order.id).exec();
      expect(settled?.status).toBe(OrderStatus.DELIVERED);
    });

    it('creates exactly one shipment even if confirmation is redelivered', async () => {
      const order = await placeGuestOrder();

      await pay(order.id).expect(201);
      await dispatcher.drain();

      await outboxModel.updateMany(
        { eventType: 'order.confirmed' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      expect(await shipmentModel.countDocuments({ orderId: order.id })).toBe(1);
    });

    it('tracks the parcel through the order number, not the shipment routes', async () => {
      const order = await placeGuestOrder();
      await pay(order.id).expect(201);
      await dispatcher.drain();

      const shipmentId = (await shipmentModel
        .findOne({ orderId: order.id })
        .exec())!._id.toString();
      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM-COD-2' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(api('/orders/lookup'))
        .query({ orderNumber: order.orderNumber })
        .expect(200);

      expect(res.body.data.shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
      expect(res.body.data.shipment.carrier).toBe('Royal Mail');
      expect(res.body.data.shipment.trackingNumber).toBe('RM-COD-2');
      expect(res.body.data.payment.status).toBe(PaymentStatus.AUTHORIZED);

      // The shipment routes themselves are for account holders and staff.
      await request(app.getHttpServer())
        .get(api(`/shipments/orders/${order.id}`))
        .expect(401);
    });

    it('refuses a payment method no provider settles', async () => {
      const order = await placeGuestOrder();

      // Bank transfer is gone from the enum entirely, so it fails validation;
      // CARD survives for a future gateway but nothing settles it yet.
      await request(app.getHttpServer())
        .post(api('/payments'))
        .send({ orderId: order.id, method: 'BANK_TRANSFER' })
        .expect(400);

      await request(app.getHttpServer())
        .post(api('/payments'))
        .send({ orderId: order.id, method: PaymentMethod.CARD })
        .expect(400);
    });

    it('lets anyone holding a guest order id confirm it, but not an account order', async () => {
      // A guest has no token, so the id checkout handed them is the only thing
      // they can present. It is unguessable and confirming a payment method is
      // the other half of placing the order.
      const order = await placeGuestOrder();
      await pay(order.id).expect(201);

      // An order that belongs to an account is a different matter: it needs that
      // account's token, or one customer could confirm another's order.
      const customer = await makeUser('account@example.com', UserRole.USER);
      const theirs = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ shippingAddress: address, items: [{ productId, variantId, quantity: 1 }] })
        .expect(201);

      await pay(theirs.body.data.id as string).expect(404);
    });
  });
});
