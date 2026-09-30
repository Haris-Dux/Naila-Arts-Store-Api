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
import { TemplateService } from '../src/modules/notifications/template.service';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxDispatcher } from '../src/modules/outbox/outbox.dispatcher';
import { OutboxDocument, OutboxMessage } from '../src/modules/outbox/schemas/outbox.schema';
import { PaymentMethod } from '../src/modules/payments/enums/payment-status.enum';
import { Payment, PaymentDocument } from '../src/modules/payments/schemas/payment.schema';
import {
  WebhookEvent,
  WebhookEventDocument,
} from '../src/modules/payments/schemas/webhook-event.schema';
import { Shipment, ShipmentDocument } from '../src/modules/shipping/schemas/shipment.schema';
import { NotificationStatus } from '../src/modules/notifications/schemas/notification-log.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createSuit, createTestApp } from './setup-app';

describe('Notifications (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let logModel: Model<NotificationLogDocument>;
  let shipmentModel: Model<ShipmentDocument>;
  let orderModel: Model<OrderDocument>;
  let paymentModel: Model<PaymentDocument>;
  let productModel: Model<ProductDocument>;
  let userModel: Model<UserDocument>;
  let outboxModel: Model<OutboxDocument>;
  let webhookModel: Model<WebhookEventDocument>;
  let dispatcher: OutboxDispatcher;
  let mailer: MailerService;
  let templates: TemplateService;
  let sendSpy: jest.SpyInstance;

  const password = 'StrongP@ssw0rd!';
  let shopperToken: string;
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
    logModel = app.get<Model<NotificationLogDocument>>(getModelToken(NotificationLog.name));
    shipmentModel = app.get<Model<ShipmentDocument>>(getModelToken(Shipment.name));
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    paymentModel = app.get<Model<PaymentDocument>>(getModelToken(Payment.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    webhookModel = app.get<Model<WebhookEventDocument>>(getModelToken(WebhookEvent.name));
    dispatcher = app.get(OutboxDispatcher);
    mailer = app.get(MailerService);
    templates = app.get(TemplateService);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const makeUser = async (email: string, role: UserRole) => {
    const registered = await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'Jane Doe', email, password })
      .expect(201);

    const id = registered.body.data.user.id as string;
    if (role !== UserRole.USER) await userModel.updateOne({ _id: id }, { $set: { role } });

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);

    return { id, token: login.body.data.tokens.accessToken as string };
  };

  const placeOrder = async () => {
    const res = await request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${shopperToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address, items: [{ productId, variantId, quantity: 2 }] })
      .expect(201);

    return res.body.data.id as string;
  };

  const payOrder = async (orderId: string) => {
    const payment = await request(app.getHttpServer())
      .post(api('/payments'))
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ orderId, method: PaymentMethod.CASH_ON_DELIVERY })
      .expect(201);

    await request(app.getHttpServer())
      .post(api(`/payments/${payment.body.data.id}/capture`))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
  };

  /** Every email sent so far, as { to, subject, html }. */
  const sentMails = () =>
    sendSpy.mock.calls.map((call) => call[0] as { to: string; subject: string; html: string });

  beforeEach(async () => {
    await Promise.all([
      logModel.deleteMany({}),
      shipmentModel.deleteMany({}),
      orderModel.deleteMany({}),
      paymentModel.deleteMany({}),
      productModel.deleteMany({}),
      userModel.deleteMany({}),
      outboxModel.deleteMany({}),
      webhookModel.deleteMany({}),
    ]);

    sendSpy = jest.spyOn(mailer, 'send');

    shopperToken = (await makeUser('shopper@example.com', UserRole.USER)).token;
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
        variants: [{ erpId: await createSuit(app, 10), color: 'Red', hex: '#b22222' }],
      })
      .expect(201);
    productId = product.body.data.id as string;
    variantId = product.body.data.variants[0].id as string;
    sendSpy.mockClear();
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  // ------------------------------------------------------------------- A13

  describe('order lifecycle emails', () => {
    it('sends an order confirmation when an order is placed', async () => {
      await placeOrder();
      await dispatcher.drain();

      const mails = sentMails();
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toBe('shopper@example.com');
      expect(mails[0].subject).toMatch(/We've received your order ORD-/);
      expect(mails[0].html).toContain('Wireless Mouse');
    });

    it('sends a payment confirmation when the order is paid', async () => {
      const orderId = await placeOrder();
      await payOrder(orderId);
      await dispatcher.drain();

      const subjects = sentMails().map((m) => m.subject);
      expect(subjects).toHaveLength(2);
      expect(subjects.some((s) => /Payment received/.test(s))).toBe(true);
    });

    it('sends a dispatch email with carrier and tracking details', async () => {
      const orderId = await placeOrder();
      await payOrder(orderId);
      await dispatcher.drain();
      sendSpy.mockClear();

      const shipment = await shipmentModel.findOne({ orderId }).exec();
      await request(app.getHttpServer())
        .post(api(`/shipments/${shipment!._id.toString()}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          carrier: 'Royal Mail',
          trackingNumber: 'RM123456789GB',
          trackingUrl: 'https://track.example.com/RM123456789GB',
        })
        .expect(201);

      await dispatcher.drain();

      const mails = sentMails();
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toMatch(/is on its way/);
      expect(mails[0].html).toContain('Royal Mail');
      expect(mails[0].html).toContain('RM123456789GB');
      expect(mails[0].html).toContain('https://track.example.com/RM123456789GB');
    });

    it('records the dispatch announcement in the same transaction as the shipment', async () => {
      const orderId = await placeOrder();
      await payOrder(orderId);
      await dispatcher.drain();

      const shipment = await shipmentModel.findOne({ orderId }).exec();
      await request(app.getHttpServer())
        .post(api(`/shipments/${shipment!._id.toString()}/dispatch`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ carrier: 'Royal Mail', trackingNumber: 'RM1' })
        .expect(201);

      // A parcel marked dispatched is guaranteed to have an announcement stored
      // with it, so the customer will be told even if the process dies here.
      const messages = await outboxModel.find({ eventType: 'shipment.dispatched' }).exec();
      expect(messages).toHaveLength(1);
      expect(messages[0].payload.trackingNumber).toBe('RM1');
    });
  });

  // -------------------------------------------------------------------- A2

  describe('the closing emails', () => {
    /** Move an order to a terminal status the way an administrator would. */
    const setStatus = (orderId: string, status: string) =>
      request(app.getHttpServer())
        .patch(api(`/orders/${orderId}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status });

    /** Walk an order out to a returned parcel. */
    const returnedOrder = async () => {
      const orderId = await placeOrder();
      for (const status of ['FULFILLING', 'SHIPPED']) {
        await setStatus(orderId, status).expect(200);
      }
      await setStatus(orderId, 'RETURNED').expect(200);
      return orderId;
    };

    it('tells the customer when their order is cancelled', async () => {
      // The event was already being recorded and consumed by nobody, so a
      // cancelled customer previously heard nothing at all.
      const orderId = await placeOrder();
      await setStatus(orderId, 'CANCELLED').expect(200);
      await dispatcher.drain();

      const mails = sentMails();
      const cancelled = mails.filter((m) => /has been cancelled/.test(m.subject));

      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].to).toBe('shopper@example.com');
      expect(cancelled[0].html).toMatch(/back into stock/i);
    });

    it('tells the customer when their order comes back, and promises no money', async () => {
      // Whether a refund is owed is settled by a person outside this system, so
      // the closing email must not claim one happened.
      await returnedOrder();
      await dispatcher.drain();

      const returned = sentMails().filter((m) => /received your return/i.test(m.subject));

      expect(returned).toHaveLength(1);
      expect(returned[0].to).toBe('shopper@example.com');
      expect(returned[0].html).not.toMatch(/refunded this order/i);
    });

    it('sends exactly one return email however often the event is redelivered', async () => {
      await returnedOrder();
      await dispatcher.drain();

      await outboxModel.updateMany(
        { eventType: 'order.returned' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      expect(sentMails().filter((m) => /received your return/i.test(m.subject))).toHaveLength(1);
    });

    it('tells the customer when their parcel arrives', async () => {
      const orderId = await placeOrder();
      await payOrder(orderId);
      await setStatus(orderId, 'FULFILLING').expect(200);
      await setStatus(orderId, 'SHIPPED').expect(200);
      await setStatus(orderId, 'DELIVERED').expect(200);
      await dispatcher.drain();

      const delivered = sentMails().filter((m) => /has arrived/.test(m.subject));

      expect(delivered).toHaveLength(1);
      expect(delivered[0].html).toMatch(/has been delivered/i);
    });

    it('sends a cancellation to a guest, who has no account', async () => {
      const guest = request.agent(app.getHttpServer());
      const placed = await guest
        .post(api('/orders/checkout'))
        .set('Idempotency-Key', randomUUID())
        .send({
          email: 'guest@example.com',
          name: 'Guest Shopper',
          shippingAddress: address,
          items: [{ productId, variantId, quantity: 1 }],
        })
        .expect(201);

      await setStatus(placed.body.data.id as string, 'CANCELLED').expect(200);
      await dispatcher.drain();

      const cancelled = sentMails().filter((m) => /has been cancelled/.test(m.subject));
      expect(cancelled).toHaveLength(1);
      // Recipient comes from the order's contact email, not from an account.
      expect(cancelled[0].to).toBe('guest@example.com');
    });

    it('does not send a cancellation twice when the outbox redelivers', async () => {
      const orderId = await placeOrder();
      await setStatus(orderId, 'CANCELLED').expect(200);
      await dispatcher.drain();

      const first = sentMails().filter((m) => /has been cancelled/.test(m.subject)).length;

      await outboxModel.updateMany(
        { eventType: 'order.cancelled' },
        { $set: { status: 'PENDING', availableAt: new Date(), attempts: 0 } },
      );
      await dispatcher.drain();

      expect(sentMails().filter((m) => /has been cancelled/.test(m.subject))).toHaveLength(first);
    });
  });

  describe('never sends the same email twice', () => {
    it('is a no-op when the outbox redelivers', async () => {
      await placeOrder();
      await dispatcher.drain();
      expect(sentMails()).toHaveLength(1);

      // Outbox delivery is at-least-once; replay the message.
      await outboxModel.updateMany(
        { eventType: 'order.placed' },
        { $set: { status: 'PENDING', availableAt: new Date() } },
      );
      await dispatcher.drain();

      // The old stack re-sent on every redelivered Kafka event.
      expect(sentMails()).toHaveLength(1);
      expect(await logModel.countDocuments({ kind: 'orderPlaced' })).toBe(1);
    });

    it('is a no-op when a queued job is retried after a successful send', async () => {
      const orderId = await placeOrder();
      await dispatcher.drain();
      sendSpy.mockClear();

      const service = app.get<{
        deliver: (job: Record<string, unknown>) => Promise<void>;
      }>(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../src/modules/notifications/notifications.service').NotificationsService,
      );

      // Exactly what BullMQ does when a worker dies after sending but before
      // acknowledging the job.
      await service.deliver({
        kind: 'orderPlaced',
        dedupeKey: `orderPlaced:${orderId}`,
        recipient: 'shopper@example.com',
        recipientName: 'Jane Doe',
        userId: null,
        data: { order: { orderNumber: 'X', total: '$0.00', items: [] } },
      });

      expect(sentMails()).toHaveLength(0);
    });

    it('records one log row per notification', async () => {
      const orderId = await placeOrder();
      await payOrder(orderId);
      await dispatcher.drain();

      const logs = await logModel.find({}).sort({ createdAt: 1 }).exec();
      expect(logs.map((l) => l.kind)).toEqual(['orderPlaced', 'orderPaid']);
      expect(logs.every((l) => l.status === NotificationStatus.SENT)).toBe(true);
      expect(logs.every((l) => l.messageId !== null)).toBe(true);
    });
  });

  describe('failure handling', () => {
    it('records a failed send and lets a retry re-claim it', async () => {
      sendSpy.mockRejectedValueOnce(new Error('SMTP unavailable'));

      await placeOrder();
      await dispatcher.drain();

      // Nothing sent — but the attempt is kept, marked FAILED, rather than
      // deleted. Deleting it used to be how the retry got its second chance,
      // and it threw away the only evidence anything had been tried; worse, a
      // send that the server had already accepted before the connection dropped
      // was then sent all over again.
      const failed = await logModel.findOne({ kind: 'orderPlaced' }).exec();
      expect(failed?.status).toBe('FAILED');
      expect(failed?.error).toMatch(/SMTP unavailable/);

      // The outbox message stays pending and backs off for retry.
      const message = await outboxModel.findOne({ eventType: 'order.placed' }).exec();
      expect(message?.status).toBe('PENDING');
      expect(message?.lastError).toMatch(/SMTP unavailable/);

      // A later attempt re-claims that same row and the customer gets their
      // email — one log row throughout, so the unique index still holds.
      await outboxModel.updateMany({}, { $set: { availableAt: new Date() } });
      await dispatcher.drain();
      expect(sentMails().length).toBeGreaterThanOrEqual(1);
      expect(await logModel.countDocuments({ kind: 'orderPlaced' })).toBe(1);
      expect((await logModel.findOne({ kind: 'orderPlaced' }).exec())?.status).toBe('SENT');
    });

    it('does not retry forever when the order has been removed', async () => {
      await placeOrder();
      await orderModel.deleteMany({});

      await dispatcher.drain();

      // No email is owed, so the message is marked delivered rather than
      // retried until it dead-letters.
      const message = await outboxModel.findOne({ eventType: 'order.placed' }).exec();
      expect(message?.status).toBe('DISPATCHED');
      expect(sentMails()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------- M4

  describe('templates and branding (M4)', () => {
    it('uses configured branding, not a hardcoded competitor domain', async () => {
      await placeOrder();
      await dispatcher.drain();

      const html = sentMails()[0].html;
      // The old template's footer named steamlevelmarket.com — another
      // company's domain, evidently copied in and never noticed.
      expect(html).not.toMatch(/steamlevelmarket/i);
      expect(html).toContain('support@example.com');
    });

    it('formats money in the store currency, not a hardcoded symbol', async () => {
      await placeOrder();
      await dispatcher.drain();

      const html = sentMails()[0].html;
      // The old template appended ₺ regardless of what the store charged in.
      expect(html).not.toContain('₺');
      expect(html).toContain('$24.99');
      expect(html).toContain('$49.98');
    });

    it('renders in English by default and Turkish on request', () => {
      const data = {
        order: {
          orderNumber: 'ORD-1',
          total: '$49.98',
          items: [
            {
              name: 'Mouse',
              color: 'Red',
              quantity: 2,
              unitPrice: '$24.99',
              lineTotal: '$49.98',
            },
          ],
        },
      };

      const english = templates.render('orderPlaced', data, 'Jane', 'en');
      expect(english.subject).toBe("We've received your order ORD-1");
      expect(english.html).toContain('Hello Jane,');

      // The old service was Turkish-only, with the strings inline in the code.
      const turkish = templates.render('orderPlaced', data, 'Jane', 'tr');
      expect(turkish.subject).toBe('ORD-1 numaralı siparişinizi aldık');
      expect(turkish.html).toContain('Merhaba Jane,');
    });

    it('falls back to English for an unsupported locale', () => {
      const rendered = templates.render(
        'orderPlaced',
        { order: { orderNumber: 'ORD-1', total: '$0.00', items: [] } },
        'Jane',
        'fr-CA',
      );
      // A missing translation must not stop a customer being told about their order.
      expect(rendered.subject).toBe("We've received your order ORD-1");
    });

    it('escapes interpolated values, so a product name cannot inject markup', () => {
      const rendered = templates.render(
        'orderPlaced',
        {
          order: {
            orderNumber: 'ORD-1',
            total: '$0.00',
            items: [
              {
                name: '<script>alert(1)</script>',
                color: 'Red',
                quantity: 1,
                unitPrice: '$0.00',
                lineTotal: '$0.00',
              },
            ],
          },
        },
        'Jane',
      );

      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).toContain('&lt;script&gt;');
    });

    it('renders a complete, self-contained document', async () => {
      await placeOrder();
      await dispatcher.drain();

      const html = sentMails()[0].html;
      expect(html).toContain('Your order is in');
      expect(html).toContain('Hello Jane Doe,');
      expect(html).toContain('Thank you for shopping with');
      // Inline styles only — email clients strip <style> blocks.
      expect(html).not.toContain('<style');
      expect(html).toContain('style="');
    });
  });
});
