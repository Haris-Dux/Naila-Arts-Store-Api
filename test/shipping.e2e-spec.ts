import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { OrderStatus } from '../src/modules/orders/enums/order-status.enum';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxDispatcher } from '../src/modules/outbox/outbox.dispatcher';
import { OutboxDocument, OutboxMessage } from '../src/modules/outbox/schemas/outbox.schema';
import { PaymentMethod, PaymentStatus } from '../src/modules/payments/enums/payment-status.enum';
import { Payment, PaymentDocument } from '../src/modules/payments/schemas/payment.schema';
import {
  WebhookEvent,
  WebhookEventDocument,
} from '../src/modules/payments/schemas/webhook-event.schema';
import { ShipmentStatus } from '../src/modules/shipping/enums/shipment-status.enum';
import { Shipment, ShipmentDocument } from '../src/modules/shipping/schemas/shipment.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

const WEBHOOK_SECRET = 'test-payment-webhook-secret-long-enough';

describe('Shipping & Outbox (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let shipmentModel: Model<ShipmentDocument>;
  let orderModel: Model<OrderDocument>;
  let paymentModel: Model<PaymentDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let outboxModel: Model<OutboxDocument>;
  let webhookModel: Model<WebhookEventDocument>;
  let dispatcher: OutboxDispatcher;

  const password = 'StrongP@ssw0rd!';
  let shopperToken: string;
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
    shipmentModel = app.get<Model<ShipmentDocument>>(getModelToken(Shipment.name));
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    paymentModel = app.get<Model<PaymentDocument>>(getModelToken(Payment.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    webhookModel = app.get<Model<WebhookEventDocument>>(getModelToken(WebhookEvent.name));
    dispatcher = app.get(OutboxDispatcher);
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

  const placeOrder = async (token = shopperToken) => {
    const res = await request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address, items: [{ productId, quantity: 2 }] })
      .expect(201);

    return res.body.data.id as string;
  };

  /** Place an order, pay it, and drain the outbox so the shipment exists. */
  const paidOrder = async (token = shopperToken) => {
    const orderId = await placeOrder(token);

    const payment = await request(app.getHttpServer())
      .post(api('/payments'))
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
      .expect(201);

    await request(app.getHttpServer())
      .post(api(`/payments/${payment.body.data.id}/capture`))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);

    await dispatcher.drain();
    return orderId;
  };

  const shipmentFor = async (orderId: string) => shipmentModel.findOne({ orderId }).exec();

  beforeEach(async () => {
    await Promise.all([
      shipmentModel.deleteMany({}),
      orderModel.deleteMany({}),
      paymentModel.deleteMany({}),
      productModel.deleteMany({}),
      userModel.deleteMany({}),
      outboxModel.deleteMany({}),
      webhookModel.deleteMany({}),
    ]);

    shopperToken = (await makeUser('shopper@example.com', UserRole.USER)).token;
    adminToken = (await makeUser('admin@example.com', UserRole.ADMIN)).token;

    // Every product needs a category now.
    const categoryId = await createCategory(app, adminToken);
    const product = await request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Wireless Mouse', price: 2499, stock: 10, categoryId })
      .expect(201);
    productId = product.body.data.id as string;
  });

  // ------------------------------------------------------------------- B6

  describe('exactly one shipment per order (B6)', () => {
    it('creates a single shipment when an order is paid', async () => {
      const orderId = await paidOrder();

      // The old handler built a document, create()d identical data, then save()d
      // the first — two inserts on every order, before redelivery even mattered.
      expect(await shipmentModel.countDocuments({ orderId })).toBe(1);

      const shipment = await shipmentFor(orderId);
      expect(shipment?.status).toBe(ShipmentStatus.PENDING);
      expect(shipment?.items).toHaveLength(1);
      expect(shipment?.shippingAddress.postalCode).toBe('M1 1AA');
    });

    it('stays at one shipment when order.paid is redelivered', async () => {
      const orderId = await paidOrder();
      const first = await shipmentFor(orderId);

      // Outbox delivery is at-least-once, so redelivery is expected. Replay the
      // message by resetting it to pending and draining again.
      await outboxModel.updateMany(
        { eventType: 'order.paid' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();
      await dispatcher.drain();

      expect(await shipmentModel.countDocuments({ orderId })).toBe(1);
      expect((await shipmentFor(orderId))?._id.toString()).toBe(first!._id.toString());
    });

    it('does not overwrite work already in progress on a replay', async () => {
      const orderId = await paidOrder();
      const shipment = await shipmentFor(orderId);

      await request(app.getHttpServer())
        .post(api(`/shipments/${shipment!._id.toString()}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM123456789GB' })
        .expect(201);

      await outboxModel.updateMany(
        { eventType: 'order.paid' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      // $setOnInsert means a replay touches nothing on an existing document.
      const after = await shipmentFor(orderId);
      expect(after?.status).toBe(ShipmentStatus.IN_TRANSIT);
      expect(after?.trackingNumber).toBe('RM123456789GB');
    });

    it('rejects a duplicate at the database level too', async () => {
      const orderId = await paidOrder();
      const existing = await shipmentFor(orderId);

      // Belt and braces: even a direct insert cannot produce a second shipment.
      await expect(
        shipmentModel.create({
          orderId: existing!.orderId,
          orderNumber: existing!.orderNumber,
          userId: existing!.userId,
          status: ShipmentStatus.PENDING,
          shippingAddress: existing!.shippingAddress,
          items: [],
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  // ------------------------------------------------------------ order.paid

  describe('driven by order.paid, not order.placed', () => {
    it('creates no shipment for an unpaid order', async () => {
      const orderId = await placeOrder();
      await dispatcher.drain();

      // The old handler fired on order creation, so unpaid and abandoned orders
      // all got shipments.
      expect(await shipmentModel.countDocuments({ orderId })).toBe(0);
    });

    it('creates no shipment for a cancelled order', async () => {
      const orderId = await placeOrder();
      await request(app.getHttpServer())
        .post(api(`/orders/${orderId}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      await dispatcher.drain();
      expect(await shipmentModel.countDocuments({ orderId })).toBe(0);
    });

    it('creates one shipment when payment arrives by webhook, not one per event', async () => {
      const orderId = await placeOrder();
      const payment = await request(app.getHttpServer())
        .post(api('/payments'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);

      const body = {
        id: randomUUID(),
        type: 'payment.captured',
        paymentReference: payment.body.data.reference as string,
      };
      const timestamp = Math.floor(Date.now() / 1000);
      const raw = JSON.stringify(body);
      const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');

      await request(app.getHttpServer())
        .post(api('/payments/webhooks/manual'))
        .set('Content-Type', 'application/json')
        .set('X-Signature', `t=${timestamp},v1=${v1}`)
        .send(raw)
        .expect(200);

      await dispatcher.drain();
      // Two confirmations reach shipping for one order — `order.confirmed` when
      // the cash-on-delivery payment opened, then `order.paid` from the webhook
      // capture. The upsert on orderId is what keeps that to a single parcel.
      expect(await shipmentModel.countDocuments({ orderId })).toBe(1);
    });
  });

  describe('outbox dispatcher', () => {
    it('marks a message dispatched and does not redeliver it', async () => {
      await paidOrder();

      const messages = await outboxModel.find({ eventType: 'order.paid' }).exec();
      expect(messages).toHaveLength(1);
      expect(messages[0].status).toBe('DISPATCHED');
      expect(messages[0].dispatchedAt).not.toBeNull();

      // Nothing left due, so a further drain is a no-op.
      expect(await dispatcher.drain()).toBe(0);
    });

    it('backs a failed message off for retry rather than losing it', async () => {
      const orderId = await placeOrder();

      // A message whose handler will throw: no such order.
      await outboxModel.create({
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.paid',
        payload: { orderId: '507f1f77bcf86cd799439011' },
        status: 'PENDING',
        availableAt: new Date(),
      });

      await dispatcher.drain();

      const message = await outboxModel
        .findOne({ 'payload.orderId': '507f1f77bcf86cd799439011' })
        .exec();

      // Still PENDING so it will be retried, with a recorded reason and a
      // future availableAt — not silently dropped.
      expect(message?.status).toBe('PENDING');
      expect(message?.attempts).toBe(1);
      expect(message?.lastError).toMatch(/not found/i);
      expect(message!.availableAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('claims each message once when drains overlap', async () => {
      await paidOrder();
      await outboxModel.updateMany({}, { $set: { status: 'PENDING', availableAt: new Date() } });

      const [a, b, c] = await Promise.all([
        dispatcher.drain(),
        dispatcher.drain(),
        dispatcher.drain(),
      ]);

      // Overlapping runs are guarded, and the lease keeps a claimed message from
      // being taken twice.
      expect(a + b + c).toBeGreaterThan(0);
      expect(await shipmentModel.countDocuments({})).toBe(1);
    });
  });

  describe('fulfilment', () => {
    let orderId: string;
    let shipmentId: string;

    beforeEach(async () => {
      orderId = await paidOrder();
      shipmentId = (await shipmentFor(orderId))!._id.toString();
    });

    const dispatchIt = (body: Record<string, unknown> = {}) =>
      request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM123456789GB', ...body });

    it('dispatching attaches tracking and moves the order to SHIPPED', async () => {
      const res = await dispatchIt({
        trackingUrl: 'https://track.example.com/RM123456789GB',
      }).expect(201);

      expect(res.body.data.status).toBe(ShipmentStatus.IN_TRANSIT);
      expect(res.body.data.trackingNumber).toBe('RM123456789GB');
      expect(res.body.data.shippedAt).not.toBeNull();
      // PENDING → PREPARING → IN_TRANSIT, recorded in full.
      expect(res.body.data.events).toHaveLength(3);

      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.SHIPPED);
    });

    it('marking delivered moves the order to DELIVERED', async () => {
      await dispatchIt().expect(201);

      const res = await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.DELIVERED, location: 'Front porch' })
        .expect(200);

      expect(res.body.data.status).toBe(ShipmentStatus.DELIVERED);
      expect(res.body.data.deliveredAt).not.toBeNull();
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.DELIVERED);
    });

    it('rejects an illegal shipment transition', async () => {
      const res = await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.DELIVERED });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('is idempotent when a carrier repeats the current status', async () => {
      await dispatchIt().expect(201);

      const first = await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.IN_TRANSIT })
        .expect(200);

      // Carrier feeds routinely repeat themselves; that is not an error.
      expect(first.body.data.status).toBe(ShipmentStatus.IN_TRANSIT);
      expect(first.body.data.events).toHaveLength(3);
    });

    it('allows a failed delivery to be retried', async () => {
      await dispatchIt().expect(201);

      await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.FAILED, note: 'Nobody home' })
        .expect(200);

      // FAILED is a retry state, not a terminal one.
      const retried = await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.IN_TRANSIT, note: 'Second attempt' })
        .expect(200);

      expect(retried.body.data.status).toBe(ShipmentStatus.IN_TRANSIT);
    });

    it('restricts dispatch and status changes to staff', async () => {
      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ carrier: 'X', trackingNumber: 'Y' })
        .expect(403);

      await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ status: ShipmentStatus.DELIVERED })
        .expect(403);

      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .send({ carrier: 'X', trackingNumber: 'Y' })
        .expect(401);
    });

    it('exposes no create endpoint', async () => {
      // A shipment exists because an order was paid for, not because it was asked for.
      await request(app.getHttpServer())
        .post(api('/shipments'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ orderId })
        .expect(404);
    });

    it('records the parcel move even when the order cannot follow', async () => {
      await dispatchIt().expect(201);
      // Refunding leaves the order terminal.
      await orderModel.updateOne({ _id: orderId }, { $set: { status: OrderStatus.REFUNDED } });

      const res = await request(app.getHttpServer())
        .patch(api(`/shipments/${shipmentId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: ShipmentStatus.DELIVERED })
        .expect(200);

      // The parcel physically arrived; that fact must be recorded regardless.
      expect(res.body.data.status).toBe(ShipmentStatus.DELIVERED);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.REFUNDED);
    });
  });

  describe('customer tracking', () => {
    it('lets a customer track their own order', async () => {
      const orderId = await paidOrder();

      const res = await request(app.getHttpServer())
        .get(api(`/shipments/orders/${orderId}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      expect(res.body.data.orderId).toBe(orderId);
      expect(res.body.data.status).toBe(ShipmentStatus.PENDING);
    });

    it("404s on another customer's shipment rather than 403", async () => {
      const orderId = await paidOrder();
      const shipment = await shipmentFor(orderId);
      const other = await makeUser('nosy@example.com', UserRole.USER);

      await request(app.getHttpServer())
        .get(api(`/shipments/${shipment!._id.toString()}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
    });

    it('lists only the customer’s own shipments', async () => {
      await paidOrder();
      const other = await makeUser('other@example.com', UserRole.USER);

      const mine = await request(app.getHttpServer())
        .get(api('/shipments'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(mine.body.data.items).toHaveLength(1);

      const theirs = await request(app.getHttpServer())
        .get(api('/shipments'))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      expect(theirs.body.data.items).toHaveLength(0);
    });

    it('ignores a userId filter from a customer', async () => {
      const orderId = await paidOrder();
      const shipment = await shipmentFor(orderId);
      const other = await makeUser('nosy2@example.com', UserRole.USER);

      const res = await request(app.getHttpServer())
        .get(api(`/shipments?userId=${shipment!.userId!.toString()}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(0);
    });

    it('lets an admin see every shipment', async () => {
      await paidOrder();

      const res = await request(app.getHttpServer())
        .get(api('/shipments'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
    });

    it('404s when the order has no shipment yet', async () => {
      const orderId = await placeOrder();
      await request(app.getHttpServer())
        .get(api(`/shipments/orders/${orderId}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(404);
    });

    it('refuses to list anything for a caller with no token', async () => {
      await paidOrder();

      // Guests track a parcel through `GET /orders/lookup`, which carries the
      // carrier and tracking number alongside the order.
      await request(app.getHttpServer()).get(api('/shipments')).expect(401);
    });

    it('rejects an unlisted sort field', async () => {
      await request(app.getHttpServer())
        .get(api('/shipments?sort=userId'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(400);
    });
  });

  // ------------------------------------------------------------ cancellation

  describe('cancelling an order closes its shipment and payment', () => {
    /** A cash-on-delivery order: the payment is open and the shipment exists. */
    const confirmedOrder = async () => {
      const orderId = await placeOrder();
      const payment = await request(app.getHttpServer())
        .post(api('/payments'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(201);
      await dispatcher.drain();
      return { orderId, paymentId: payment.body.data.id as string };
    };

    const cancel = (orderId: string, token = shopperToken) =>
      request(app.getHttpServer())
        .post(api(`/orders/${orderId}/cancel`))
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(201);

    it('cancels the pending shipment and the open payment', async () => {
      const { orderId, paymentId } = await confirmedOrder();
      expect((await shipmentFor(orderId))?.status).toBe(ShipmentStatus.PENDING);

      const res = await cancel(orderId);
      // The customer's response is unchanged; the cascade happens behind it.
      expect(res.body.data.status).toBe(OrderStatus.CANCELLED);
      await dispatcher.drain();

      expect((await shipmentFor(orderId))?.status).toBe(ShipmentStatus.CANCELLED);
      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(PaymentStatus.CANCELLED);
    });

    it('is safe to redeliver', async () => {
      const { orderId } = await confirmedOrder();
      await cancel(orderId);
      await dispatcher.drain();

      await outboxModel.updateMany(
        { eventType: 'order.cancelled' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      const shipment = await shipmentFor(orderId);
      expect(shipment?.status).toBe(ShipmentStatus.CANCELLED);
      expect(shipment?.events.filter((e) => e.status === ShipmentStatus.CANCELLED)).toHaveLength(1);
    });

    it('refuses to dispatch a cancelled order, and sends no dispatch notice', async () => {
      const { orderId } = await confirmedOrder();
      const shipmentId = (await shipmentFor(orderId))!._id.toString();
      // Not drained: the guard must hold even before the cascade has run.
      await cancel(orderId, adminToken);

      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM123456789GB' })
        .expect(409);

      expect((await shipmentFor(orderId))?.status).toBe(ShipmentStatus.PENDING);
      expect(await outboxModel.countDocuments({ eventType: 'shipment.dispatched' })).toBe(0);
    });

    it('refuses to record a payment on a cancelled order', async () => {
      const { orderId, paymentId } = await confirmedOrder();
      // Not drained, so the payment is still open when capture is attempted.
      await cancel(orderId, adminToken);

      await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(409);

      expect((await paymentModel.findById(paymentId).exec())?.status).not.toBe(
        PaymentStatus.CAPTURED,
      );
    });

    it('leaves a shipment that has already left alone', async () => {
      const orderId = await paidOrder();
      const shipmentId = (await shipmentFor(orderId))!._id.toString();
      await request(app.getHttpServer())
        .post(api(`/shipments/${shipmentId}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM123456789GB' })
        .expect(201);

      // SHIPPED cannot be cancelled by the order machine; force it to exercise
      // the handler's own guard.
      await orderModel.updateOne({ _id: orderId }, { $set: { status: OrderStatus.CANCELLED } });
      await outboxModel.create({
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.cancelled',
        payload: { orderId },
      });
      await dispatcher.drain();

      expect((await shipmentFor(orderId))?.status).toBe(ShipmentStatus.IN_TRANSIT);
    });
  });
});
