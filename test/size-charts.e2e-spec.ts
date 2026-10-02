import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { ProductSizing } from '../src/modules/products/enums/product-sizing.enum';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { SizeChart, SizeChartDocument } from '../src/modules/size-charts/schemas/size-chart.schema';
import { Size, SizeDocument } from '../src/modules/sizes/schemas/size.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createCategory, createSuit, createTestApp } from './setup-app';

/**
 * Size charts: kept by the merchant, chosen by products sold stitched, and read
 * by the storefront.
 */
describe('Size charts (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let productModel: Model<ProductDocument>;
  let sizeModel: Model<SizeDocument>;
  let chartModel: Model<SizeChartDocument>;
  let userModel: Model<UserDocument>;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;
  let categoryId: string;
  let small: string;
  let medium: string;
  let large: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    sizeModel = app.get<Model<SizeDocument>>(getModelToken(Size.name));
    chartModel = app.get<Model<SizeChartDocument>>(getModelToken(SizeChart.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
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
      chartModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);

    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
    categoryId = await createCategory(app, adminToken);

    small = await makeSize('Small', 'S', 1);
    medium = await makeSize('Medium', 'M', 2);
    large = await makeSize('Large', 'L', 3);
  });

  const asAdmin = (method: 'post' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())[method](api(path)).set('Authorization', `Bearer ${adminToken}`);

  /** The shirt half of the client's Polawn chart, in S and M. */
  const polawn = () => ({
    name: 'Polawn',
    note: 'All mentioned sizes in inches',
    measurements: ['SHOULDER', 'BUST', 'TROUSER_LENGTH'],
    rows: [
      { sizeId: small, values: [14, 19, 39] },
      { sizeId: medium, values: [14.5, 20.5, 40] },
    ],
  });

  const createChart = (body: Record<string, unknown> = polawn()) =>
    asAdmin('post', '/size-charts').send(body);

  /**
   * A product sold stitched in S and M, with whatever else `body` says.
   *
   * Returns just `expect`, like the supertest request it wraps: the colour's
   * suit has to exist before the request is sent.
   */
  const postProduct = (body: Record<string, unknown> = {}) => ({
    expect: async (status: number) =>
      asAdmin('post', '/products')
        .send({
          name: 'Lawn Suit',
          categoryId,
          offers: [{ sizing: ProductSizing.SIZED, price: 4999 }],
          sizes: [small, medium],
          variants: [{ erpId: await createSuit(app, 10), color: 'Red', hex: '#b22222' }],
          ...body,
        })
        .expect(status),
  });

  // ---------------------------------------------------------------- CRUD

  describe('the merchant keeps size charts', () => {
    it('creates a chart, with its sizes and measurements named', async () => {
      const res = await createChart().expect(201);

      expect(res.body.data).toMatchObject({
        name: 'Polawn',
        note: 'All mentioned sizes in inches',
        measurements: [
          { key: 'SHOULDER', label: 'Shoulder', group: 'SHIRT' },
          { key: 'BUST', label: 'Bust', group: 'SHIRT' },
          { key: 'TROUSER_LENGTH', label: 'Trouser length', group: 'TROUSER' },
        ],
        rows: [
          { size: { id: small, code: 'S', name: 'Small' }, values: [14, 19, 39] },
          { size: { id: medium, code: 'M', name: 'Medium' }, values: [14.5, 20.5, 40] },
        ],
      });
    });

    it('stores the columns in chart order, moving each value with its column', async () => {
      const res = await createChart({
        name: 'Shuffled',
        measurements: ['TROUSER_WAIST', 'SHOULDER', 'HIP'],
        // Sent out of size order too.
        rows: [
          { sizeId: large, values: [33, 15, 24.5] },
          { sizeId: small, values: [28, 14, 20.5] },
        ],
      }).expect(201);

      expect(res.body.data.measurements.map((m: { key: string }) => m.key)).toEqual([
        'SHOULDER',
        'HIP',
        'TROUSER_WAIST',
      ]);
      expect(
        res.body.data.rows.map((row: { size: { code: string }; values: number[] }) => [
          row.size.code,
          row.values,
        ]),
      ).toEqual([
        ['S', [14, 20.5, 28]],
        ['L', [15, 24.5, 33]],
      ]);
    });

    it('lets anyone read a chart, but only an admin list or change them', async () => {
      const id = (await createChart().expect(201)).body.data.id as string;

      await request(app.getHttpServer())
        .get(api(`/size-charts/${id}`))
        .expect(200);

      await request(app.getHttpServer())
        .get(api('/size-charts'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(api('/size-charts'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send(polawn())
        .expect(403);

      const listed = await request(app.getHttpServer())
        .get(api('/size-charts'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(listed.body.data.map((chart: { name: string }) => chart.name)).toEqual(['Polawn']);
    });

    it('offers the nine measurements to choose from', async () => {
      const res = await request(app.getHttpServer())
        .get(api('/size-charts/measurements'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(9);
      expect(res.body.data[6]).toEqual({
        key: 'SLEEVE_LENGTH',
        label: 'Sleeve length',
        group: 'SHIRT',
      });
    });

    it('edits a chart: its name, note, and table', async () => {
      const id = (await createChart().expect(201)).body.data.id as string;

      const edited = await asAdmin('patch', `/size-charts/${id}`)
        .send({
          name: 'Polawn 2026',
          note: null,
          measurements: ['WAIST'],
          rows: [{ sizeId: large, values: [22] }],
        })
        .expect(200);

      expect(edited.body.data).toMatchObject({
        name: 'Polawn 2026',
        note: null,
        measurements: [{ key: 'WAIST' }],
        rows: [{ size: { code: 'L' }, values: [22] }],
      });

      // The rows alone are valued in the chart's current columns.
      const revalued = await asAdmin('patch', `/size-charts/${id}`)
        .send({ rows: [{ sizeId: medium, values: [20] }] })
        .expect(200);
      expect(revalued.body.data.rows).toMatchObject([{ size: { code: 'M' }, values: [20] }]);
    });

    it('shows a renamed size under its new name', async () => {
      const id = (await createChart().expect(201)).body.data.id as string;

      await asAdmin('patch', `/sizes/${small}`).send({ code: 'SM' }).expect(200);

      const res = await request(app.getHttpServer())
        .get(api(`/size-charts/${id}`))
        .expect(200);
      expect(res.body.data.rows[0].size.code).toBe('SM');
    });

    it('deletes a chart no product uses', async () => {
      const id = (await createChart().expect(201)).body.data.id as string;

      await asAdmin('delete', `/size-charts/${id}`).expect(200);

      await request(app.getHttpServer())
        .get(api(`/size-charts/${id}`))
        .expect(404);
      // Its name is free again.
      await createChart().expect(201);
    });
  });

  // ---------------------------------------------------------- validation

  describe('a chart must be a whole table', () => {
    it('refuses a chart that does not add up', async () => {
      const base = polawn();

      for (const body of [
        { ...base, measurements: ['SHOULDER', 'NECK', 'TROUSER_LENGTH'] },
        { ...base, measurements: [] },
        { ...base, rows: [] },
        { ...base, rows: [{ sizeId: small, values: [14, 19] }] },
        {
          ...base,
          rows: [
            { sizeId: small, values: [14, 19, 39] },
            { sizeId: small, values: [14, 19, 39] },
          ],
        },
        { ...base, rows: [{ sizeId: small, values: [14.125, 19, 39] }] },
        { ...base, rows: [{ sizeId: small, values: [-1, 19, 39] }] },
        { ...base, rows: [{ sizeId: '0123456789abcdef01234567', values: [14, 19, 39] }] },
        { ...base, name: '' },
      ]) {
        await createChart(body).expect(400);
      }
      expect(await chartModel.countDocuments({})).toBe(0);
    });

    it('refuses a second chart by the same name', async () => {
      await createChart().expect(201);
      await createChart().expect(409);
    });

    it('refuses new columns without the values to fill them', async () => {
      const id = (await createChart().expect(201)).body.data.id as string;

      const res = await asAdmin('patch', `/size-charts/${id}`)
        .send({ measurements: ['SHOULDER', 'HIP', 'TROUSER_LENGTH'] })
        .expect(400);
      expect(res.body.message).toMatch(/rows with the measurements/i);
    });
  });

  // ------------------------------------------------------------- products

  describe('a product sold stitched may show a chart', () => {
    it('keeps the chart it was given', async () => {
      const chartId = (await createChart().expect(201)).body.data.id as string;

      const created = await postProduct({ sizeChartId: chartId }).expect(201);
      expect(created.body.data.sizeChartId).toBe(chartId);

      const unset = await asAdmin('patch', `/products/${created.body.data.id as string}`)
        .send({ sizeChartId: null })
        .expect(200);
      expect(unset.body.data.sizeChartId).toBeNull();
    });

    it('refuses a chart on a product sold only unstitched', async () => {
      const chartId = (await createChart().expect(201)).body.data.id as string;

      const res = await postProduct({
        offers: [{ sizing: ProductSizing.UNSTITCHED, price: 3999 }],
        sizes: [],
        sizeChartId: chartId,
      }).expect(400);
      expect(res.body.message).toMatch(/only a product sold stitched/i);
    });

    it('refuses to stop selling stitched while the chart is still set', async () => {
      const chartId = (await createChart().expect(201)).body.data.id as string;
      const id = (await postProduct({ sizeChartId: chartId }).expect(201)).body.data.id as string;
      const unstitched = [{ sizing: ProductSizing.UNSTITCHED, price: 3999 }];

      await asAdmin('patch', `/products/${id}`).send({ offers: unstitched, sizes: [] }).expect(400);

      const dropped = await asAdmin('patch', `/products/${id}`)
        .send({ offers: unstitched, sizes: [], sizeChartId: null })
        .expect(200);
      expect(dropped.body.data.sizeChartId).toBeNull();
    });

    it('refuses a chart that does not exist', async () => {
      const res = await postProduct({ sizeChartId: '0123456789abcdef01234567' }).expect(400);
      expect(res.body.message).toMatch(/size chart does not exist/i);
    });

    it('refuses to delete a chart a product shows', async () => {
      const chartId = (await createChart().expect(201)).body.data.id as string;
      await postProduct({ sizeChartId: chartId }).expect(201);

      const res = await asAdmin('delete', `/size-charts/${chartId}`).expect(409);
      expect(res.body.message).toMatch(/1 product/);
    });

    it('refuses to delete a size a chart lists', async () => {
      await createChart().expect(201);

      const res = await asAdmin('delete', `/sizes/${medium}`).expect(409);
      expect(res.body.message).toMatch(/1 size chart/);

      // One the chart does not list deletes fine.
      await asAdmin('delete', `/sizes/${large}`).expect(200);
    });
  });
});
