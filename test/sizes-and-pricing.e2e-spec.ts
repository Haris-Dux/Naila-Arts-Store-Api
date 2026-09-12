import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import request from 'supertest';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { Order, OrderDocument } from '../src/modules/orders/schemas/order.schema';
import { ProductSizing } from '../src/modules/products/enums/product-sizing.enum';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { Size, SizeDocument } from '../src/modules/sizes/schemas/size.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createTestApp } from './setup-app';

/**
 * Sizes, promotional pricing, and the units-sold counter.
 *
 * The three are tested together because checkout is where they meet: a line
 * records the size the customer chose, is charged the price that is actually
 * running, and moves the counter.
 */
describe('Sizes, promotions and units sold (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let productModel: Model<ProductDocument>;
  let sizeModel: Model<SizeDocument>;
  let orderModel: Model<OrderDocument>;
  let userModel: Model<UserDocument>;
  let inventory: InventoryService;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;
  let categoryId: string;
  let small: string;
  let medium: string;
  let large: string;

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
    sizeModel = app.get<Model<SizeDocument>>(getModelToken(Size.name));
    orderModel = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    inventory = app.get(InventoryService);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const makeUser = async (email: string, role: UserRole) => {
    const registered = await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'Test User', email, password })
      .expect(201);

    if (role !== UserRole.USER) {
      await userModel.updateOne(
        { _id: registered.body.data.user.id as string },
        { $set: { role } },
      );
    }

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);

    return login.body.data.tokens.accessToken as string;
  };

  const makeSize = async (name: string, code: string, order: number): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post(api('/sizes'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, code, order })
      .expect(201);
    return created.body.data.id as string;
  };

  beforeEach(async () => {
    await Promise.all([
      productModel.deleteMany({}),
      sizeModel.deleteMany({}),
      orderModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);

    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
    categoryId = await createCategory(app, adminToken);

    small = await makeSize('Small', 'S', 1);
    medium = await makeSize('Medium', 'M', 2);
    large = await makeSize('Large', 'L', 3);
  });

  const postProduct = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/products'))
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Lawn Suit', price: 4999, stock: 20, categoryId, ...body });

  const makeProduct = async (body: Record<string, unknown> = {}): Promise<string> =>
    (await postProduct(body).expect(201)).body.data.id as string;

  const patchProduct = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(api(`/products/${id}`))
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  const checkout = (items: Record<string, unknown>[]) =>
    request(app.getHttpServer())
      .post(api('/orders/checkout'))
      .set('Authorization', `Bearer ${shopperToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ shippingAddress: address, items });

  // ------------------------------------------------------------------ sizes

  describe('sizes are a collection the merchant owns', () => {
    it('lists sizes in the stated order, not alphabetically', async () => {
      // "XL" sorts before "S"; a size run has no natural order, so it is stated.
      await makeSize('Extra Large', 'XL', 4);

      const res = await request(app.getHttpServer()).get(api('/sizes')).expect(200);
      expect(res.body.data.map((s: { code: string }) => s.code)).toEqual(['S', 'M', 'L', 'XL']);
    });

    it('keeps size codes unique and upper-cased', async () => {
      const created = await request(app.getHttpServer())
        .post(api('/sizes'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Extra Small', code: 'xs' })
        .expect(201);
      expect(created.body.data.code).toBe('XS');

      await request(app.getHttpServer())
        .post(api('/sizes'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Duplicate', code: 'XS' })
        .expect(409);
    });

    it('restricts writes to admins', async () => {
      await request(app.getHttpServer())
        .post(api('/sizes'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ name: 'Nope', code: 'NP' })
        .expect(403);

      await request(app.getHttpServer()).get(api('/sizes')).expect(200);
    });

    it('refuses to delete a size products still offer', async () => {
      await makeProduct({ sizes: [small, medium] });

      const refused = await request(app.getHttpServer())
        .delete(api(`/sizes/${small}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(refused.body.message).toMatch(/1 product/);

      // Unused ones delete fine.
      await request(app.getHttpServer())
        .delete(api(`/sizes/${large}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
    });

    it('hides inactive sizes from shoppers but shows them to staff', async () => {
      await request(app.getHttpServer())
        .patch(api(`/sizes/${large}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(200);

      const shopper = await request(app.getHttpServer())
        .get(api('/sizes?includeInactive=true'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(shopper.body.data.map((s: { code: string }) => s.code)).toEqual(['S', 'M']);

      const staff = await request(app.getHttpServer())
        .get(api('/sizes?includeInactive=true'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(staff.body.data).toHaveLength(3);
    });
  });

  // -------------------------------------------------------- product sizing

  describe('a product is sized or unstitched, never both', () => {
    it('infers UNSTITCHED when no sizes are given', async () => {
      // The unstitched suit. Not a size option — a garment form, so it lives on
      // the product rather than polluting the size list.
      const res = await postProduct().expect(201);
      expect(res.body.data.sizing).toBe(ProductSizing.UNSTITCHED);
      expect(res.body.data.sizes).toEqual([]);
    });

    it('infers SIZED when sizes are given', async () => {
      const res = await postProduct({ sizes: [medium, small] }).expect(201);
      expect(res.body.data.sizing).toBe(ProductSizing.SIZED);
      // Stored in the merchant's display order, not the order they were sent in.
      expect(res.body.data.sizes.map((s: { code: string }) => s.code)).toEqual(['S', 'M']);
    });

    it('refuses a pair that contradicts itself', async () => {
      await postProduct({ sizing: ProductSizing.SIZED, sizes: [] }).expect(400);
      await postProduct({ sizing: ProductSizing.UNSTITCHED, sizes: [small] }).expect(400);
    });

    it('accepts an explicit statement that agrees with the list', async () => {
      await postProduct({ sizing: ProductSizing.SIZED, sizes: [small] }).expect(201);
      await postProduct({ name: 'Unstitched Suit', sizing: ProductSizing.UNSTITCHED }).expect(201);
    });

    it('rejects a size that does not exist rather than dropping it', async () => {
      const res = await postProduct({ sizes: [small, '0123456789abcdef01234567'] }).expect(400);
      expect(res.body.message).toMatch(/do not exist/i);
    });

    it('flips sizing when the size list is edited', async () => {
      const id = await makeProduct({ sizes: [small, medium] });

      const stripped = await patchProduct(id, { sizes: [] }).expect(200);
      expect(stripped.body.data.sizing).toBe(ProductSizing.UNSTITCHED);

      const restored = await patchProduct(id, { sizes: [large] }).expect(200);
      expect(restored.body.data.sizing).toBe(ProductSizing.SIZED);
    });

    it('filters the catalogue by size and by form', async () => {
      await makeProduct({ name: 'Stitched S', sizes: [small] });
      await makeProduct({ name: 'Stitched L', sizes: [large] });
      await makeProduct({ name: 'Unstitched piece' });

      const bySize = await request(app.getHttpServer())
        .get(api(`/products?sizeId=${small}`))
        .expect(200);
      expect(bySize.body.data.items.map((p: { name: string }) => p.name)).toEqual(['Stitched S']);

      const unstitched = await request(app.getHttpServer())
        .get(api(`/products?sizing=${ProductSizing.UNSTITCHED}`))
        .expect(200);
      expect(unstitched.body.data.items.map((p: { name: string }) => p.name)).toEqual([
        'Unstitched piece',
      ]);
    });

    it('names the sizes on a detail view and gives ids on a listing', async () => {
      // A list page must not fan out into one size lookup per product.
      const id = await makeProduct({ sizes: [medium] });

      const detail = await request(app.getHttpServer())
        .get(api(`/products/${id}`))
        .expect(200);
      expect(detail.body.data.sizes[0]).toMatchObject({ id: medium, name: 'Medium', code: 'M' });

      const listed = await request(app.getHttpServer()).get(api('/products')).expect(200);
      expect(listed.body.data.items[0].sizes[0]).toMatchObject({ id: medium, code: null });
    });
  });

  // ---------------------------------------------------- size at checkout

  describe('an order records the size that was bought', () => {
    it('requires a size for a sized product', async () => {
      const id = await makeProduct({ sizes: [small, medium] });

      const res = await checkout([{ productId: id, quantity: 1 }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/choose a size/i);
      expect(await orderModel.countDocuments({})).toBe(0);
    });

    it('refuses a size the product is not offered in', async () => {
      const id = await makeProduct({ sizes: [small] });

      const res = await checkout([{ productId: id, quantity: 1, sizeId: large }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not available in that size/i);
    });

    it('refuses a size on an unstitched product', async () => {
      const id = await makeProduct();

      const res = await checkout([{ productId: id, quantity: 1, sizeId: medium }]);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/unstitched/i);
    });

    it('snapshots the size, so renaming it later does not rewrite history', async () => {
      const id = await makeProduct({ sizes: [medium] });
      const order = await checkout([{ productId: id, quantity: 2, sizeId: medium }]).expect(201);

      expect(order.body.data.items[0].size).toMatchObject({ name: 'Medium', code: 'M' });

      await request(app.getHttpServer())
        .patch(api(`/sizes/${medium}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Med', code: 'MED' })
        .expect(200);

      const reread = await request(app.getHttpServer())
        .get(api(`/orders/${order.body.data.id as string}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(reread.body.data.items[0].size).toMatchObject({ name: 'Medium', code: 'M' });
    });

    it('keeps two sizes of one product as two lines', async () => {
      // Not a duplicate to fold: a picker has to see them separately.
      const id = await makeProduct({ sizes: [small, medium] });

      const order = await checkout([
        { productId: id, quantity: 2, sizeId: small },
        { productId: id, quantity: 3, sizeId: medium },
      ]).expect(201);

      expect(order.body.data.items).toHaveLength(2);
      expect(
        order.body.data.items.map((i: { size: { code: string } }) => i.size.code).sort(),
      ).toEqual(['M', 'S']);
      // One stock pool, so both lines draw from it.
      expect((await productModel.findById(id).exec())?.stock).toBe(15);
    });

    it('still folds a repeated product in the same size', async () => {
      const id = await makeProduct({ sizes: [medium] });

      const order = await checkout([
        { productId: id, quantity: 2, sizeId: medium },
        { productId: id, quantity: 3, sizeId: medium },
      ]).expect(201);

      expect(order.body.data.items).toHaveLength(1);
      expect(order.body.data.items[0].quantity).toBe(5);
    });

    it('leaves the size null on an unstitched line', async () => {
      const id = await makeProduct();
      const order = await checkout([{ productId: id, quantity: 1 }]).expect(201);
      expect(order.body.data.items[0].size).toBeNull();
    });
  });

  // ------------------------------------------------------------ promotions

  describe('promotional price', () => {
    it('leaves the regular price alone and reports both', async () => {
      const res = await postProduct({ price: 4999, promotionalPrice: 2999 }).expect(201);

      expect(res.body.data.price.amount).toBe(4999);
      expect(res.body.data.promotionalPrice.amount).toBe(2999);
      expect(res.body.data.effectivePrice.amount).toBe(2999);
      expect(res.body.data.isOnPromotion).toBe(true);
    });

    it('falls back to the regular price with no promotion', async () => {
      const res = await postProduct({ price: 4999 }).expect(201);
      expect(res.body.data.promotionalPrice).toBeNull();
      expect(res.body.data.effectivePrice.amount).toBe(4999);
      expect(res.body.data.isOnPromotion).toBe(false);
    });

    it('ends a promotion by nulling one field, restoring the original price', async () => {
      // The reason for a second field: no one has to remember what `price` was.
      const id = await makeProduct({ price: 4999, promotionalPrice: 2999 });

      const ended = await patchProduct(id, { promotionalPrice: null }).expect(200);
      expect(ended.body.data.price.amount).toBe(4999);
      expect(ended.body.data.effectivePrice.amount).toBe(4999);
      expect(ended.body.data.isOnPromotion).toBe(false);
    });

    it('refuses a promotion that is not a discount', async () => {
      await postProduct({ price: 4999, promotionalPrice: 4999 }).expect(400);
      const res = await postProduct({ price: 4999, promotionalPrice: 5999 }).expect(400);
      expect(res.body.message).toMatch(/lower than the regular price/i);
    });

    it('judges a price change against the promotion already running', async () => {
      // Merged state, not the patch alone: dropping the list price beneath a
      // live promotion leaves an "offer" that costs more.
      const id = await makeProduct({ price: 4999, promotionalPrice: 2999 });

      await patchProduct(id, { price: 2000 }).expect(400);
      const ok = await patchProduct(id, { price: 5999 }).expect(200);
      expect(ok.body.data.effectivePrice.amount).toBe(2999);
    });

    it('charges the promotional price, and the order records it', async () => {
      const id = await makeProduct({ price: 4999, promotionalPrice: 2999 });

      const order = await checkout([{ productId: id, quantity: 2 }]).expect(201);

      expect(order.body.data.items[0].unitPrice.amount).toBe(2999);
      expect(order.body.data.grandTotal.amount).toBe(5998);
    });

    it('keeps the price the customer paid after the promotion ends', async () => {
      const id = await makeProduct({ price: 4999, promotionalPrice: 2999 });
      const order = await checkout([{ productId: id, quantity: 1 }]).expect(201);

      await patchProduct(id, { promotionalPrice: null }).expect(200);

      const reread = await request(app.getHttpServer())
        .get(api(`/orders/${order.body.data.id as string}`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(reread.body.data.items[0].unitPrice.amount).toBe(2999);
    });

    it('filters by price band and by promotion against what is charged', async () => {
      await makeProduct({ name: 'Full price', price: 4999 });
      await makeProduct({ name: 'Discounted', price: 9999, promotionalPrice: 3999 });

      // 9999 is outside the band; 3999 — what it actually costs — is inside.
      const banded = await request(app.getHttpServer())
        .get(api('/products?maxPrice=5000'))
        .expect(200);
      expect(banded.body.data.items.map((p: { name: string }) => p.name).sort()).toEqual([
        'Discounted',
        'Full price',
      ]);

      const onOffer = await request(app.getHttpServer())
        .get(api('/products?onPromotion=true'))
        .expect(200);
      expect(onOffer.body.data.items.map((p: { name: string }) => p.name)).toEqual(['Discounted']);
    });
  });

  // ------------------------------------------------------------ units sold

  describe('units sold', () => {
    it('counts up when an order is placed', async () => {
      const id = await makeProduct({ sizes: [medium] });

      await checkout([{ productId: id, quantity: 3, sizeId: medium }]).expect(201);

      const product = await productModel.findById(id).exec();
      expect(product?.sellCount).toBe(3);
      expect(product?.stock).toBe(17);
    });

    it('counts back down when the order is cancelled', async () => {
      const id = await makeProduct();
      const order = await checkout([{ productId: id, quantity: 4 }]).expect(201);

      await request(app.getHttpServer())
        .post(api(`/orders/${order.body.data.id as string}/cancel`))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({})
        .expect(201);

      const product = await productModel.findById(id).exec();
      expect(product?.sellCount).toBe(0);
      expect(product?.stock).toBe(20);
    });

    it('un-counts the sale when units come back', async () => {
      // Restores are the only way stock rises here now — supplier deliveries
      // belong to the ERP, which books them when a branch receives the goods.
      const id = await makeProduct();
      await inventory.decrease(id, 6);
      expect((await productModel.findById(id).exec())?.sellCount).toBe(6);

      await inventory.restore(id, 2);
      expect((await productModel.findById(id).exec())?.sellCount).toBe(4);

      await inventory.restore(id, 4);
      expect((await productModel.findById(id).exec())?.sellCount).toBe(0);
    });

    it('never goes negative', async () => {
      const id = await makeProduct();
      await inventory.restore(id, 5);
      expect((await productModel.findById(id).exec())?.sellCount).toBe(0);
    });

    it('ranks the catalogue by it', async () => {
      const quiet = await makeProduct({ name: 'Quiet' });
      const popular = await makeProduct({ name: 'Popular' });
      await checkout([{ productId: popular, quantity: 5 }]).expect(201);
      await checkout([{ productId: quiet, quantity: 1 }]).expect(201);

      const res = await request(app.getHttpServer())
        .get(api('/products?sort=sellCount&order=desc'))
        .expect(200);
      expect(res.body.data.items.map((p: { name: string }) => p.name)).toEqual([
        'Popular',
        'Quiet',
      ]);
    });
  });
});
