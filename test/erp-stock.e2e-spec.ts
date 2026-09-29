import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { ErpStockSyncService } from '../src/modules/erp/erp-stock-sync.service';
import { Suit, SuitDocument } from '../src/modules/erp/schemas/suit.schema';
import { SUIT_FIELDS } from '../src/modules/erp/suit-fields';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

/**
 * Stock for each colour of a product — an ERP suit — lives in the ERP, not here.
 *
 * These tests pin the two halves of that: the store consuming the ERP's number
 * when it sells, and the ERP's own movements (a branch booking a bill) reaching
 * the mirror the catalogue reads.
 */
describe('ERP stock (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let productModel: Model<ProductDocument>;
  let suitModel: Model<SuitDocument>;
  let userModel: Model<UserDocument>;
  let sync: ErpStockSyncService;

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
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    suitModel = app.get<Model<SuitDocument>>(getModelToken(Suit.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    sync = app.get(ErpStockSyncService);
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

    return login.body.data.tokens.accessToken as string;
  };

  /**
   * A suit shaped like the ERP's real documents, including the fields this
   * store knows nothing about — which are what a careless write would destroy.
   */
  const makeSuit = async (stock: number, fields: Record<string, unknown> = {}) => {
    const id = new Types.ObjectId();
    await suitModel.collection.insertOne({
      _id: id,
      [SUIT_FIELDS.design]: 600,
      [SUIT_FIELDS.category]: 'Lawn',
      [SUIT_FIELDS.color]: 'Red',
      quantity: stock,
      cost_price: 1800,
      sale_price: 3200,
      all_records: [{ bill: 'LHR-0001', qty: 2 }],
      createdAt: new Date('2026-07-07T18:34:55.948Z'),
      updatedAt: new Date('2026-07-09T19:35:59.269Z'),
      __v: 7,
      ...fields,
    });
    return id;
  };

  /** A suit as one design × category × colour, the way the ERP files them. */
  const makeDesign = (stock: number, designNo: unknown, category: string, color: string) =>
    makeSuit(stock, {
      [SUIT_FIELDS.design]: designNo,
      [SUIT_FIELDS.category]: category,
      [SUIT_FIELDS.color]: color,
    });

  /** A store product whose colours are these suits, in this order. */
  const createOn = (suitIds: (Types.ObjectId | string)[], extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `Suit ${randomUUID().slice(0, 8)}`,
        categoryId,
        offers: [{ sizing: 'UNSTITCHED', price: 4999 }],
        variants: suitIds.map((erpId, index) => ({
          erpId: erpId.toString(),
          color: `Colour ${index + 1}`,
        })),
        ...extra,
      });

  /** A store product in one colour: this suit. */
  const makeProduct = async (suitId: Types.ObjectId) => {
    const created = await createOn([suitId]).expect(201);
    return {
      id: created.body.data.id as string,
      colour: created.body.data.variants[0].id as string,
    };
  };

  const checkout = (product: { id: string; colour: string }, quantity: number) =>
    request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${shopperToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        shippingAddress: address,
        items: [{ productId: product.id, variantId: product.colour, quantity }],
      });

  /** The product's total, across its colours. */
  const stockOf = async (product: { id: string }) =>
    (await productModel.findById(product.id).lean().exec())?.stock;

  /** Each colour's own figure, in order. */
  const colourStocks = async (product: { id: string }) =>
    (await productModel.findById(product.id).lean().exec())?.variants.map((v) => v.stock);

  const suitStock = async (suitId: Types.ObjectId) =>
    (await suitModel.collection.findOne({ _id: suitId }))?.quantity;

  beforeEach(async () => {
    await Promise.all([
      productModel.deleteMany({}),
      suitModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);

    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
    categoryId = await createCategory(app, adminToken);
  });

  describe('selling a product', () => {
    it('takes the units from the ERP, not just from the mirror', async () => {
      const suitId = await makeSuit(10);
      const product = await makeProduct(suitId);

      await checkout(product, 3).expect(201);

      // The ERP's own figure moved. Without this, a branch would keep selling
      // units the storefront had already sold.
      expect(await suitStock(suitId)).toBe(7);
      expect(await stockOf(product)).toBe(7);
    });

    it('takes the units from the colour sold, and from no other', async () => {
      const red = await makeSuit(10);
      const blue = await makeSuit(6);
      const created = await createOn([red, blue]).expect(201);
      const product = {
        id: created.body.data.id as string,
        colour: created.body.data.variants[1].id as string,
      };

      await checkout(product, 2).expect(201);

      expect(await suitStock(blue)).toBe(4);
      expect(await suitStock(red)).toBe(10);
      expect(await colourStocks(product)).toEqual([10, 4]);
      expect(await stockOf(product)).toBe(14);
    });

    it('refuses the sale when the ERP is short, and leaves no order behind', async () => {
      const suitId = await makeSuit(99);
      const product = await makeProduct(suitId);
      await suitModel.collection.updateOne({ _id: suitId }, { $set: { quantity: 2 } });

      // The mirror says 99 — deliberately stale. The ERP's 2 is what counts.
      const res = await checkout(product, 5);
      expect(res.status).toBe(409);

      expect(await suitStock(suitId)).toBe(2);

      const orders = await request(app.getHttpServer())
        .get(api('/orders'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(orders.body.data.items).toHaveLength(0);
    });

    it('refuses to sell a product whose suit has vanished', async () => {
      const suitId = await makeSuit(10);
      const product = await makeProduct(suitId);
      await suitModel.deleteOne({ _id: suitId });

      // Falling back to the mirror here would be selling from a number nobody
      // maintains any more.
      const res = await checkout(product, 1);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('never writes back the ERP fields it does not know about', async () => {
      const suitId = await makeSuit(10);
      const product = await makeProduct(suitId);

      await checkout(product, 1).expect(201);

      const suit = await suitModel.collection.findOne({ _id: suitId });
      // A full-document save through a partial schema would have removed these,
      // and a Mongoose save would have bumped the ERP's own version counter.
      expect(suit).toMatchObject({
        cost_price: 1800,
        sale_price: 3200,
        all_records: [{ bill: 'LHR-0001', qty: 2 }],
        updatedAt: new Date('2026-07-09T19:35:59.269Z'),
        __v: 7,
      });
      expect(suit?.quantity).toBe(9);
    });

    it('puts the units back in the ERP when the order is cancelled', async () => {
      const suitId = await makeSuit(10);
      const product = await makeProduct(suitId);

      const placed = await checkout(product, 4).expect(201);
      expect(await suitStock(suitId)).toBe(6);

      await request(app.getHttpServer())
        .patch(api(`/orders/${placed.body.data.id}/status`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CANCELLED' })
        .expect(200);

      expect(await suitStock(suitId)).toBe(10);
      expect(await stockOf(product)).toBe(10);
    });
  });

  describe('changes made in the ERP reach the catalogue', () => {
    it('mirrors a branch bill onto the product', async () => {
      const suitId = await makeSuit(20);
      const product = await makeProduct(suitId);

      // A worker books a sale at a branch: the ERP moves its own number and the
      // store hears about it only through the change stream.
      await suitModel.collection.updateOne({ _id: suitId }, { $inc: { quantity: -6 } });
      await sync.onChange({
        _id: { _data: 'token-1' },
        documentKey: { _id: suitId },
        fullDocument: { _id: suitId, quantity: 14 },
      });

      expect(await stockOf(product)).toBe(14);
    });

    it('mirrors onto that colour alone, and re-totals the product', async () => {
      const red = await makeSuit(20);
      const blue = await makeSuit(5);
      const created = await createOn([red, blue]).expect(201);
      const product = { id: created.body.data.id as string };

      await sync.onChange({
        _id: { _data: 'token-colour' },
        documentKey: { _id: blue },
        fullDocument: { _id: blue, quantity: 2 },
      });

      expect(await colourStocks(product)).toEqual([20, 2]);
      expect(await stockOf(product)).toBe(22);
    });

    it('mirrors onto every product built on the same suit', async () => {
      const suitId = await makeSuit(20);
      const first = await makeProduct(suitId);
      // Refused through the API; written here as a stray record would be.
      const second = await makeProduct(await makeSuit(20));
      await productModel.updateOne(
        { _id: second.id },
        { $set: { 'variants.0.erpId': suitId.toString() } },
      );

      await sync.onChange({
        _id: { _data: 'token-2' },
        documentKey: { _id: suitId },
        fullDocument: { _id: suitId, quantity: 3 },
      });

      expect(await stockOf(first)).toBe(3);
      expect(await stockOf(second)).toBe(3);
    });

    it('ignores a change that did not touch stock', async () => {
      const suitId = await makeSuit(20);
      const product = await makeProduct(suitId);

      await sync.onChange({
        _id: { _data: 'token-3' },
        documentKey: { _id: suitId },
        fullDocument: { _id: suitId },
      });

      expect(await stockOf(product)).toBe(20);
    });

    it('remembers where it got to, so a restart resumes', async () => {
      const suitId = await makeSuit(5);
      await makeProduct(suitId);

      await sync.onChange({
        _id: { _data: 'token-4' },
        documentKey: { _id: suitId },
        fullDocument: { _id: suitId, quantity: 4 },
      });

      const checkpoint = await productModel.db
        .collection('erp_sync_checkpoints')
        .findOne({ name: 'suits-stock' });
      expect(checkpoint?.token).toEqual({ _data: 'token-4' });
    });
  });

  describe('the real change stream', () => {
    /**
     * The tests above hand `onChange` a synthetic event, which proves the
     * mapping but not the plumbing. This opens an actual stream against the
     * in-memory replica set and writes to `suits` the way the ERP would.
     */
    it('carries a real ERP write through to the mirror', async () => {
      const suitId = await makeSuit(30);
      const product = await makeProduct(suitId);

      await sync.start();

      try {
        await suitModel.collection.updateOne({ _id: suitId }, { $inc: { quantity: -11 } });

        // The stream is asynchronous; poll rather than sleep a fixed time.
        const deadline = Date.now() + 15_000;
        let mirrored: number | undefined;
        do {
          mirrored = await stockOf(product);
          if (mirrored === 19) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);

        expect(mirrored).toBe(19);
      } finally {
        await sync.onModuleDestroy();
      }
    }, 30_000);
  });

  describe('reconciliation', () => {
    it('corrects a mirror that has drifted from the ERP', async () => {
      const suitId = await makeSuit(12);
      const product = await makeProduct(suitId);

      // What a missed change-stream window looks like: the ERP moved on and the
      // mirror never heard.
      await suitModel.collection.updateOne({ _id: suitId }, { $set: { quantity: 4 } });
      expect(await stockOf(product)).toBe(12);

      const corrected = await sync.reconcile();

      expect(corrected).toBe(1);
      expect(await stockOf(product)).toBe(4);
    });

    it('corrects each drifted colour on its own, and re-totals the product', async () => {
      const red = await makeSuit(12);
      const blue = await makeSuit(3);
      const created = await createOn([red, blue]).expect(201);
      const product = { id: created.body.data.id as string };

      await suitModel.collection.updateOne({ _id: red }, { $set: { quantity: 7 } });

      expect(await sync.reconcile()).toBe(1);
      expect(await colourStocks(product)).toEqual([7, 3]);
      expect(await stockOf(product)).toBe(10);
    });

    it('leaves a product alone when its suit cannot be found', async () => {
      const suitId = await makeSuit(9);
      const product = await makeProduct(suitId);
      await suitModel.deleteOne({ _id: suitId });

      // Zeroing on a failed lookup would hide the catalogue on a transient read.
      expect(await sync.reconcile()).toBe(0);
      expect(await stockOf(product)).toBe(9);
    });

    it('does nothing when everything already agrees', async () => {
      const suitId = await makeSuit(8);
      await makeProduct(suitId);

      expect(await sync.reconcile()).toBe(0);
    });

    it('agrees with the ERP after a sale, so the sweep finds no drift', async () => {
      const suitId = await makeSuit(10);
      const product = await makeProduct(suitId);

      await checkout(product, 3).expect(201);

      // The store wrote both numbers in one transaction; the sweep is the proof
      // that it wrote the same number to each.
      expect(await sync.reconcile()).toBe(0);
    });
  });

  describe('choosing a suit to build a product on', () => {
    const designs = (search?: string, token = adminToken) =>
      request(app.getHttpServer())
        .get(api(`/erp/suits/designs${search ? `?search=${search}` : ''}`))
        .set('Authorization', `Bearer ${token}`);

    const colors = (designNo: string, category: string) =>
      request(app.getHttpServer())
        .get(api(`/erp/suits/colors?designNo=${designNo}&category=${category}`))
        .set('Authorization', `Bearer ${adminToken}`);

    it('groups designs by design and category, leaving out anything without stock', async () => {
      await makeDesign(5, '871', 'Lawn', 'Red');
      await makeDesign(3, '871', 'Lawn', 'Black');
      await makeDesign(0, '871', 'Lawn', 'Green');
      await makeDesign(4, '871', 'Chiffon', 'Red');
      await makeDesign(0, '900', 'Lawn', 'Red');

      const res = await designs().expect(200);

      // The same design number in two categories is two different suits.
      // Design 900 has nothing to sell, so it is not offered at all.
      expect(res.body.data).toEqual([
        { designNo: '871', category: 'Chiffon', colorCount: 1, stock: 4 },
        { designNo: '871', category: 'Lawn', colorCount: 2, stock: 8 },
      ]);
    });

    it('searches by the start of the design number, stored as text or as a number', async () => {
      await makeDesign(5, '871', 'Lawn', 'Red');
      await makeDesign(5, 872, 'Lawn', 'Red');
      await makeDesign(5, '79', 'Lawn', 'Red');

      const res = await designs('87').expect(200);

      expect(res.body.data.map((d: { designNo: string }) => d.designNo).sort()).toEqual([
        '871',
        '872',
      ]);
    });

    it('lists the in-stock colours of one design, each with its stock', async () => {
      const red = await makeDesign(5, '871', 'Lawn', 'Red');
      await makeDesign(0, '871', 'Lawn', 'Black');
      const blue = await makeDesign(2, '871', 'Lawn', 'Blue');
      await makeDesign(4, '871', 'Chiffon', 'Red');

      const res = await colors('871', 'Lawn').expect(200);

      expect(res.body.data).toEqual([
        { suitId: blue.toString(), color: 'Blue', stock: 2 },
        { suitId: red.toString(), color: 'Red', stock: 5 },
      ]);
    });

    it('finds the colours of a design the ERP stored as a number', async () => {
      const red = await makeDesign(6, 872, 'Lawn', 'Red');

      const res = await colors('872', 'Lawn').expect(200);

      expect(res.body.data).toEqual([{ suitId: red.toString(), color: 'Red', stock: 6 }]);
    });

    it("reads the ERP's real document: d_no as a number, stock in quantity", async () => {
      const sample = {
        category: 'Lawn',
        color: 'Red',
        quantity: 0,
        cost_price: 0,
        sale_price: 0,
        d_no: 600,
        all_records: [],
        createdAt: new Date('2026-07-07T18:34:55.948Z'),
        updatedAt: new Date('2026-07-09T19:35:59.269Z'),
        __v: 7,
      };
      await suitModel.collection.insertOne({ _id: new Types.ObjectId(), ...sample });
      const blue = new Types.ObjectId();
      await suitModel.collection.insertOne({ _id: blue, ...sample, color: 'Blue', quantity: 4 });

      // Red has quantity 0, so only Blue is offered — and "60" finds design 600.
      const found = await designs('60').expect(200);
      expect(found.body.data).toEqual([
        { designNo: '600', category: 'Lawn', colorCount: 1, stock: 4 },
      ]);

      const res = await colors('600', 'Lawn').expect(200);
      expect(res.body.data).toEqual([{ suitId: blue.toString(), color: 'Blue', stock: 4 }]);
    });

    it('is not open to shoppers', async () => {
      await designs(undefined, shopperToken).expect(403);
    });

    it("takes a new colour's stock from the suit, and never from the request", async () => {
      const suitId = await makeDesign(7, '871', 'Lawn', 'Red');

      const res = await createOn([suitId]).expect(201);

      expect(res.body.data.variants[0]).toMatchObject({ stock: 7, erpId: suitId.toString() });
      expect(res.body.data.stock).toBe(7);
      const stored = await productModel.findById(res.body.data.id).lean().exec();
      expect(stored?.variants[0].erpSyncedAt).toBeInstanceOf(Date);

      // Stock is the ERP's to state, so there is no field to type it into.
      const other = await makeDesign(7, '871', 'Lawn', 'Blue');
      await createOn([other], { stock: 99 }).expect(400);
      await createOn([], {
        variants: [{ erpId: other.toString(), color: 'Blue', stock: 99 }],
      }).expect(400);
    });

    it('sells a product built this way from the ERP', async () => {
      const suitId = await makeDesign(7, '871', 'Lawn', 'Red');
      const product = await makeProduct(suitId);

      await checkout(product, 2).expect(201);

      expect(await suitStock(suitId)).toBe(5);
    });

    it('refuses a suit that does not exist', async () => {
      await createOn([new Types.ObjectId()]).expect(404);
    });

    it('refuses a suit with nothing in stock', async () => {
      const suitId = await makeDesign(0, '871', 'Lawn', 'Red');
      await createOn([suitId]).expect(400);
    });

    it('refuses a suit another product is already built on', async () => {
      const suitId = await makeDesign(7, '871', 'Lawn', 'Red');
      await createOn([suitId]).expect(201);

      await createOn([suitId]).expect(409);
    });

    it('never moves a colour onto another suit: another suit is another colour', async () => {
      const suitId = await makeDesign(7, '871', 'Lawn', 'Red');
      const other = await makeDesign(4, '871', 'Lawn', 'Black');
      const created = await createOn([suitId]).expect(201);
      const edit = (body: Record<string, unknown>) =>
        request(app.getHttpServer())
          .patch(api(`/products/${created.body.data.id}`))
          .set('Authorization', `Bearer ${adminToken}`)
          .send(body);

      await edit({ erpId: other.toString() }).expect(400);

      const swapped = await edit({
        variants: [{ erpId: other.toString(), color: 'Colour 1' }],
      }).expect(200);
      expect(swapped.body.data.variants[0].id).not.toBe(created.body.data.variants[0].id);
      expect(swapped.body.data.variants[0].stock).toBe(4);
    });
  });

  describe('the catalogue reads the mirror', () => {
    it('hides a product the ERP has run out of', async () => {
      const suitId = await makeSuit(3);
      const product = await makeProduct(suitId);

      await suitModel.collection.updateOne({ _id: suitId }, { $set: { quantity: 0 } });
      await sync.onChange({
        _id: { _data: 'token-5' },
        documentKey: { _id: suitId },
        fullDocument: { _id: suitId, quantity: 0 },
      });

      const res = await request(app.getHttpServer()).get(api('/products?inStock=true')).expect(200);

      expect(res.body.data.items.map((p: { id: string }) => p.id)).not.toContain(product.id);
    });
  });
});
