import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { OutboxDocument, OutboxMessage } from '../src/modules/outbox/schemas/outbox.schema';
import { PaymentMethod, PaymentStatus } from '../src/modules/payments/enums/payment-status.enum';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { ManualPaymentProvider } from '../src/modules/payments/provider/manual-payment.provider';
import { Payment, PaymentDocument } from '../src/modules/payments/schemas/payment.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

/**
 * Regression tests for defects found during the pre-review verification sweep.
 *
 * Both were privilege/consistency gaps that the feature suites missed because
 * they exercise the happy path of each module in isolation, and these live at
 * the seams between modules.
 */
describe('Verification regressions (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let userModel: Model<UserDocument>;
  let productModel: Model<ProductDocument>;
  let orderModel: Model<OrderDocument>;
  let paymentModel: Model<PaymentDocument>;
  let outboxModel: Model<OutboxDocument>;
  let paymentsService: PaymentsService;
  let manualProvider: ManualPaymentProvider;

  const password = 'StrongP@ssw0rd!';

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
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    paymentModel = app.get<Model<PaymentDocument>>(getModelToken(Payment.name));
    outboxModel = app.get<Model<OutboxDocument>>(getModelToken(OutboxMessage.name));
    paymentsService = app.get(PaymentsService);
    manualProvider = app.get(ManualPaymentProvider);
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

  beforeEach(async () => {
    await Promise.all([
      userModel.deleteMany({}),
      productModel.deleteMany({}),
      orderModel.deleteMany({}),
      paymentModel.deleteMany({}),
      outboxModel.deleteMany({}),
    ]);
  });

  // ------------------------------------------------------------------- V1

  describe('a customer cannot edit another account (V1)', () => {
    it("refuses to change another customer's email", async () => {
      const attacker = await makeUser('attacker@example.com', UserRole.USER);
      const victim = await makeUser('victim@example.com', UserRole.USER);

      // Changing someone's email is an account-takeover primitive: it hands the
      // address to the attacker and locks the real owner out of signing in.
      // With two peer roles this is the boundary that remains — administrators
      // manage each other by design, so a departed one can be deactivated.
      const res = await request(app.getHttpServer())
        .patch(api(`/users/${victim.id}`))
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({ email: 'attacker-owned@example.com' });

      expect(res.status).toBe(403);

      const stored = await userModel.findById(victim.id).exec();
      expect(stored?.email).toBe('victim@example.com');
    });

    it('lets an admin manage a peer, so a departed one can be deactivated', async () => {
      const admin = await makeUser('admin1@example.com', UserRole.ADMIN);
      const peer = await makeUser('admin2@example.com', UserRole.ADMIN);

      await request(app.getHttpServer())
        .patch(api(`/users/${peer.id}/access`))
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ isActive: false })
        .expect(200);

      expect((await userModel.findById(peer.id).exec())?.isActive).toBe(false);
    });

    it('still lets an ADMIN edit an ordinary customer', async () => {
      const admin = await makeUser('admin@example.com', UserRole.ADMIN);
      const customer = await makeUser('customer@example.com', UserRole.USER);

      const res = await request(app.getHttpServer())
        .patch(api(`/users/${customer.id}`))
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Corrected Name' })
        .expect(200);

      expect(res.body.data.name).toBe('Corrected Name');
    });

    it('still lets anyone edit their own profile', async () => {
      const superAdmin = await makeUser('super@example.com', UserRole.ADMIN);

      await request(app.getHttpServer())
        .patch(api('/users/me'))
        .set('Authorization', `Bearer ${superAdmin.token}`)
        .send({ name: 'Self Edit' })
        .expect(200);
    });
  });

  // ------------------------------------------------------------------- V2

  describe('a payment is captured exactly once (V2)', () => {
    const placeAndOpenPayment = async () => {
      const admin = await makeUser('catalogue-admin@example.com', UserRole.ADMIN);
      const shopper = await makeUser('shopper@example.com', UserRole.USER);

      const categoryId = await createCategory(app, admin.token);
      const product = await request(app.getHttpServer())
        .post(api('/products'))
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Widget', price: 2499, stock: 10, categoryId })
        .expect(201);

      const order = await request(app.getHttpServer())
        .post(api('/orders/checkout'))
        .set('Authorization', `Bearer ${shopper.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          shippingAddress: address,
          items: [{ productId: product.body.data.id, quantity: 2 }],
        })
        .expect(201);

      const payment = await request(app.getHttpServer())
        .post(api('/payments'))
        .set('Authorization', `Bearer ${shopper.token}`)
        .send({ orderId: order.body.data.id, method: PaymentMethod.BANK_TRANSFER })
        .expect(201);

      return { orderId: order.body.data.id as string, paymentId: payment.body.data.id as string };
    };

    it('calls the gateway once when captures race', async () => {
      const { paymentId } = await placeAndOpenPayment();
      const captureSpy = jest.spyOn(manualProvider, 'capture');

      // An administrator double-clicking, or an admin capture landing at the
      // same moment as the provider's webhook. Nothing deduplicates these
      // against each other: the webhook event id and the BullMQ job id each
      // guard their own path only.
      const results = await Promise.allSettled([
        paymentsService.capture(paymentId, null, 'first'),
        paymentsService.capture(paymentId, null, 'second'),
        paymentsService.capture(paymentId, null, 'third'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

      // The money must move once. With a real gateway a second call is a second
      // charge; the manual provider makes it invisible, which is precisely why
      // it would go unnoticed until a gateway is plugged in.
      expect(captureSpy).toHaveBeenCalledTimes(1);
      captureSpy.mockRestore();
    });

    it('records one capture event and one order.paid', async () => {
      const { orderId, paymentId } = await placeAndOpenPayment();

      await Promise.allSettled([
        paymentsService.capture(paymentId, null),
        paymentsService.capture(paymentId, null),
        paymentsService.capture(paymentId, null),
      ]);

      const payment = await paymentModel.findById(paymentId).exec();
      expect(payment?.status).toBe(PaymentStatus.CAPTURED);

      // A duplicated event would make the payment's audit trail lie about how
      // many times money moved.
      const captureEvents = payment!.events.filter(
        (e) => e.status === PaymentStatus.CAPTURED,
      ).length;
      expect(captureEvents).toBe(1);

      expect(await outboxModel.countDocuments({ eventType: 'order.paid' })).toBe(1);
      expect((await orderModel.findById(orderId).exec())?.statusHistory).toHaveLength(2);
    });

    it('does not over-refund when refunds race (V3)', async () => {
      const { paymentId } = await placeAndOpenPayment();
      await paymentsService.capture(paymentId, null);

      const admin = await makeUser('refunder@example.com', UserRole.ADMIN);
      const actor = {
        id: admin.id,
        email: 'refunder@example.com',
        role: UserRole.ADMIN,
        tokenVersion: 0,
      };
      const refundSpy = jest.spyOn(manualProvider, 'refund');

      // Two operators refunding 3000 each against a 4998 payment. Sequentially
      // the second is rejected; concurrently both read amountRefunded = 0.
      await Promise.allSettled([
        paymentsService.refund(paymentId, actor, 3000),
        paymentsService.refund(paymentId, actor, 3000),
      ]);

      const payment = await paymentModel.findById(paymentId).exec();
      // The customer must never be given back more than they paid.
      expect(payment!.amountRefunded).toBeLessThanOrEqual(payment!.amount);
      const refunded = refundSpy.mock.calls.reduce((sum, c) => sum + c[1], 0);
      expect(refunded).toBeLessThanOrEqual(4998);
      refundSpy.mockRestore();
    });

    it('remains idempotent for a sequential repeat', async () => {
      const { paymentId } = await placeAndOpenPayment();

      const first = await paymentsService.capture(paymentId, null);
      const second = await paymentsService.capture(paymentId, null);

      expect(first.status).toBe(PaymentStatus.CAPTURED);
      expect(second.status).toBe(PaymentStatus.CAPTURED);
    });
  });
});
