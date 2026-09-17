import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { OrderStatus } from '../src/modules/orders/enums/order-status.enum';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxDocument, OutboxMessage } from '../src/modules/outbox/schemas/outbox.schema';
import { PaymentMethod, PaymentStatus } from '../src/modules/payments/enums/payment-status.enum';
import { Payment, PaymentDocument } from '../src/modules/payments/schemas/payment.schema';
import {
  WebhookEvent,
  WebhookEventDocument,
} from '../src/modules/payments/schemas/webhook-event.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

const WEBHOOK_SECRET = 'test-payment-webhook-secret-long-enough';

describe('Payments (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let paymentModel: Model<PaymentDocument>;
  let orderModel: Model<OrderDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let outboxModel: Model<OutboxDocument>;
  let webhookModel: Model<WebhookEventDocument>;

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
    paymentModel = app.get<Model<PaymentDocument>>(getModelToken(Payment.name));
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    webhookModel = app.get<Model<WebhookEventDocument>>(getModelToken(WebhookEvent.name));
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

  /** Place an order and return its id and total. */
  const placeOrder = async (token = shopperToken, quantity = 2) => {
    const res = await request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address, items: [{ productId, quantity }] })
      .expect(201);

    return { id: res.body.data.id as string, total: res.body.data.grandTotal.amount as number };
  };

  const startPayment = (
    orderId: string,
    method: PaymentMethod = PaymentMethod.CASH_ON_DELIVERY,
    token = shopperToken,
  ) =>
    request(app.getHttpServer())
      .post(api('/payments'))
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId, method });

  /** Sign a webhook body exactly as a gateway would. */
  const sign = (
    body: unknown,
    secret = WEBHOOK_SECRET,
    timestamp = Math.floor(Date.now() / 1000),
  ) => {
    const raw = JSON.stringify(body);
    const v1 = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return { raw, signature: `t=${timestamp},v1=${v1}` };
  };

  const postWebhook = (body: unknown, signature: string | undefined, provider = 'manual') => {
    const req = request(app.getHttpServer())
      .post(api(`/payments/webhooks/${provider}`))
      .set('Content-Type', 'application/json');
    if (signature) req.set('X-Signature', signature);
    return req.send(typeof body === 'string' ? body : JSON.stringify(body));
  };

  beforeEach(async () => {
    await Promise.all([
      paymentModel.deleteMany({}),
      orderModel.deleteMany({}),
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

  // ------------------------------------------------------------------- A4

  describe('a payment step exists (A4)', () => {
    it('opens a payment carrying the order total and the collection instructions', async () => {
      const order = await placeOrder();
      const res = await startPayment(order.id).expect(201);

      // Authorized, not pending: the customer has committed and the courier
      // will collect, so fulfilment need not wait for the money.
      expect(res.body.data.status).toBe(PaymentStatus.AUTHORIZED);
      expect(res.body.data.amount.amount).toBe(order.total);
      expect(res.body.data.provider).toBe('manual');
      expect(res.body.data.instructions.method).toBe(PaymentMethod.CASH_ON_DELIVERY);
      expect(res.body.data.instructions.paymentReference).toBeDefined();
    });

    it('takes the amount from the order, not the request', async () => {
      const order = await placeOrder();

      // `amount` is not on CreatePaymentDto — the same reasoning that keeps
      // prices off CheckoutDto.
      await request(app.getHttpServer())
        .post(api('/payments'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ orderId: order.id, method: PaymentMethod.CASH_ON_DELIVERY, amount: 1 })
        .expect(400);
    });

    it('moves the order to PAID on capture, and only then', async () => {
      const order = await placeOrder();
      const payment = await startPayment(order.id).expect(201);

      // Still PENDING while the cash is uncollected.
      expect((await orderModel.findById(order.id).exec())?.status).toBe(OrderStatus.PENDING);

      await request(app.getHttpServer())
        .post(api(`/payments/${payment.body.data.id}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ note: 'Cash collected on delivery' })
        .expect(201);

      const settled = await orderModel.findById(order.id).exec();
      expect(settled?.status).toBe(OrderStatus.PAID);
      expect(settled?.paidAt).not.toBeNull();
    });

    it('records order.paid in the outbox', async () => {
      const order = await placeOrder();
      const payment = await startPayment(order.id).expect(201);

      await request(app.getHttpServer())
        .post(api(`/payments/${payment.body.data.id}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201);

      // What shipping (Phase 7) and notifications (Phase 8) will consume.
      const messages = await outboxModel.find({ eventType: 'order.paid' }).exec();
      expect(messages).toHaveLength(1);
      expect(messages[0].aggregateId.toString()).toBe(order.id);
    });

    it('confirms the order so fulfilment can start before any money moves', async () => {
      const order = await placeOrder();
      await startPayment(order.id).expect(201);

      // The courier collects at the door, so shipping is told to begin now
      // rather than waiting for a capture that cannot happen yet.
      const messages = await outboxModel.find({ eventType: 'order.confirmed' }).exec();
      expect(messages).toHaveLength(1);
      expect(messages[0].aggregateId.toString()).toBe(order.id);
    });

    it('rejects a payment method no provider supports', async () => {
      const order = await placeOrder();

      // CARD is declared for the gateway that will come later; nothing settles
      // it today, and the enum no longer carries BANK_TRANSFER at all.
      await startPayment(order.id, PaymentMethod.CARD).expect(400);
    });

    it('refuses to pay for an order that is not awaiting payment', async () => {
      const order = await placeOrder();
      await request(app.getHttpServer())
        .post(api(`/orders/${order.id}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      const res = await startPayment(order.id);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/CANCELLED/);
    });

    it('returns the existing attempt rather than opening a second', async () => {
      const order = await placeOrder();

      const first = await startPayment(order.id).expect(201);
      const second = await startPayment(order.id).expect(201);

      // Two live references would let the customer pay against the wrong one.
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await paymentModel.countDocuments({})).toBe(1);
    });
  });

  describe('webhook signature verification', () => {
    let paymentId: string;
    let reference: string;

    beforeEach(async () => {
      const order = await placeOrder();
      const payment = await startPayment(order.id).expect(201);
      paymentId = payment.body.data.id as string;
      reference = payment.body.data.reference as string;
    });

    const captureEvent = (overrides: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      type: 'payment.captured',
      paymentReference: reference,
      amount: 4998,
      ...overrides,
    });

    it('rejects a webhook with no signature', async () => {
      await postWebhook(captureEvent(), undefined).expect(401);
      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(
        PaymentStatus.AUTHORIZED,
      );
    });

    it('rejects a forged signature', async () => {
      const body = captureEvent();
      await postWebhook(body, 't=1,v1=deadbeef').expect(401);
      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(
        PaymentStatus.AUTHORIZED,
      );
    });

    it('rejects a signature made with the wrong secret', async () => {
      const body = captureEvent();
      const { signature } = sign(body, 'a-different-secret-that-is-long-enough');
      await postWebhook(body, signature).expect(401);
    });

    it('rejects a signature that does not cover the body actually sent', async () => {
      // Signature computed over one payload, a different one delivered — the
      // attack that verifying re-serialised JSON instead of raw bytes allows.
      const { signature } = sign(captureEvent({ amount: 1 }));
      await postWebhook(captureEvent({ amount: 999999 }), signature).expect(401);
    });

    it('rejects a stale timestamp, so a captured request cannot be replayed', async () => {
      const body = captureEvent();
      const hourAgo = Math.floor(Date.now() / 1000) - 3600;
      const { signature } = sign(body, WEBHOOK_SECRET, hourAgo);
      await postWebhook(body, signature).expect(401);
    });

    it('accepts a correctly signed webhook and captures the payment', async () => {
      const body = captureEvent();
      const { signature } = sign(body);

      await postWebhook(body, signature).expect(200);

      const payment = await paymentModel.findById(paymentId).exec();
      expect(payment?.status).toBe(PaymentStatus.CAPTURED);
      expect(payment?.capturedAt).not.toBeNull();
      expect((await orderModel.findById(payment!.orderId).exec())?.status).toBe(OrderStatus.PAID);
    });
  });

  describe('webhook idempotency (A2)', () => {
    let paymentId: string;
    let orderId: string;
    let reference: string;

    beforeEach(async () => {
      const order = await placeOrder();
      orderId = order.id;
      const payment = await startPayment(order.id).expect(201);
      paymentId = payment.body.data.id as string;
      reference = payment.body.data.reference as string;
    });

    it('treats a redelivered event as a no-op', async () => {
      const body = { id: randomUUID(), type: 'payment.captured', paymentReference: reference };
      const { signature } = sign(body);

      const first = await postWebhook(body, signature).expect(200);
      expect(first.body.duplicate).toBe(false);

      // Gateways guarantee at-least-once delivery: this *will* happen.
      const second = await postWebhook(body, signature).expect(200);
      expect(second.body.duplicate).toBe(true);

      const order = await orderModel.findById(orderId).exec();
      expect(order?.status).toBe(OrderStatus.PAID);
      // One transition, not two: PENDING → PAID.
      expect(order?.statusHistory).toHaveLength(2);
      expect(await outboxModel.countDocuments({ eventType: 'order.paid' })).toBe(1);
    });

    it('deduplicates concurrent redeliveries', async () => {
      const body = { id: randomUUID(), type: 'payment.captured', paymentReference: reference };
      const { signature } = sign(body);

      const results = await Promise.all([
        postWebhook(body, signature),
        postWebhook(body, signature),
        postWebhook(body, signature),
      ]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
      expect(await outboxModel.countDocuments({ eventType: 'order.paid' })).toBe(1);
    });

    it('ignores an out-of-order event that would regress state', async () => {
      const capture = { id: randomUUID(), type: 'payment.captured', paymentReference: reference };
      await postWebhook(capture, sign(capture).signature).expect(200);

      // A `failed` arriving after a capture — normal with at-least-once delivery,
      // but CAPTURED → FAILED is not a legal transition.
      const failed = { id: randomUUID(), type: 'payment.failed', paymentReference: reference };
      await postWebhook(failed, sign(failed).signature).expect(200);

      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(PaymentStatus.CAPTURED);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.PAID);
    });

    it('accepts an event for an unknown payment without asking for a retry', async () => {
      // A 4xx would make the gateway retry forever over something we do not have.
      const body = { id: randomUUID(), type: 'payment.captured', paymentReference: 'NOT-OURS' };
      await postWebhook(body, sign(body).signature).expect(200);
    });

    it('ignores an unrecognised event type', async () => {
      const body = { id: randomUUID(), type: 'payment.something_new', paymentReference: reference };
      // Unparseable into a known status, so it fails verification rather than
      // being guessed at.
      await postWebhook(body, sign(body).signature).expect(401);
      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(
        PaymentStatus.AUTHORIZED,
      );
    });

    it('leaves the order payable after a failed payment', async () => {
      const body = { id: randomUUID(), type: 'payment.failed', paymentReference: reference };
      await postWebhook(body, sign(body).signature).expect(200);

      expect((await paymentModel.findById(paymentId).exec())?.status).toBe(PaymentStatus.FAILED);
      // Still PENDING so another method can be tried — cancelling here would
      // also release stock the customer may still want.
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.PENDING);
    });
  });

  describe('capture and refund', () => {
    let paymentId: string;
    let orderId: string;

    beforeEach(async () => {
      const order = await placeOrder();
      orderId = order.id;
      const payment = await startPayment(order.id).expect(201);
      paymentId = payment.body.data.id as string;
    });

    const capture = () =>
      request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/capture`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

    it('restricts capture to staff', async () => {
      await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/capture`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(403);

      await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/capture`))
        .send({})
        .expect(401);
    });

    it('is idempotent on a repeated capture', async () => {
      await capture().expect(201);
      const again = await capture().expect(201);

      expect(again.body.data.status).toBe(PaymentStatus.CAPTURED);
      const order = await orderModel.findById(orderId).exec();
      expect(order?.statusHistory).toHaveLength(2);
      expect(await outboxModel.countDocuments({ eventType: 'order.paid' })).toBe(1);
    });

    it('refunds in full and moves the order to REFUNDED', async () => {
      await capture().expect(201);

      const res = await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/refund`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Customer returned the item' })
        .expect(201);

      expect(res.body.data.status).toBe(PaymentStatus.REFUNDED);
      expect(res.body.data.amountRefunded.amount).toBe(4998);
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.REFUNDED);
    });

    it('refunds in part, leaving the order standing', async () => {
      await capture().expect(201);

      const res = await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/refund`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 2000 })
        .expect(201);

      expect(res.body.data.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(res.body.data.amountRefunded.amount).toBe(2000);
      // The customer still has goods that were partly paid for.
      expect((await orderModel.findById(orderId).exec())?.status).toBe(OrderStatus.PAID);
    });

    it('refuses to refund more than remains', async () => {
      await capture().expect(201);

      await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/refund`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 3000 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/refund`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/remains/i);
    });

    it('refuses to refund a payment that was never captured', async () => {
      const res = await request(app.getHttpServer())
        .post(api(`/payments/${paymentId}/refund`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('visibility', () => {
    it("404s on another customer's payment rather than 403", async () => {
      const order = await placeOrder();
      const payment = await startPayment(order.id).expect(201);
      const other = await makeUser('nosy@example.com', UserRole.USER);

      // 403 would confirm the id exists.
      await request(app.getHttpServer())
        .get(api(`/payments/${payment.body.data.id}`))
        .set('Authorization', `Bearer ${other.token}`)
        .expect(404);
    });

    it("refuses to open a payment against another customer's order", async () => {
      const order = await placeOrder();
      const other = await makeUser('nosy2@example.com', UserRole.USER);

      await startPayment(order.id, PaymentMethod.CASH_ON_DELIVERY, other.token).expect(404);
    });

    it('lets a customer see their own payment and an admin see any', async () => {
      const order = await placeOrder();
      const payment = await startPayment(order.id).expect(201);

      await request(app.getHttpServer())
        .get(api(`/payments/${payment.body.data.id}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .get(api(`/payments/${payment.body.data.id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('lists payments for an order', async () => {
      const order = await placeOrder();
      await startPayment(order.id).expect(201);

      const res = await request(app.getHttpServer())
        .get(api(`/payments/orders/${order.id}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('refuses to open a payment for an order the caller cannot prove is theirs', async () => {
      const order = await placeOrder();

      // The route is open so guests can pay, but an unidentified caller owns
      // nothing — 404 rather than 401, so order ids stay unprobeable.
      await request(app.getHttpServer())
        .post(api('/payments'))
        .send({ orderId: order.id, method: PaymentMethod.CASH_ON_DELIVERY })
        .expect(404);
    });
  });

  describe('provider registry', () => {
    it('404s on an unknown provider', async () => {
      const body = { id: randomUUID(), type: 'payment.captured', paymentReference: 'X' };
      await postWebhook(body, sign(body).signature, 'stripe').expect(404);
    });
  });
});
