import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { minorUnitExponent } from '../src/common/money';
import { TestContext, api, createTestApp } from './setup-app';

describe('Store config (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('is readable without authentication', async () => {
    // A storefront needs it on first paint, before anyone has logged in.
    const res = await request(app.getHttpServer()).get(api('/store/config')).expect(200);

    expect(res.body.data).toEqual({
      currency: 'USD',
      minorUnitExponent: 2,
      name: expect.any(String),
      timezone: expect.any(String),
    });
  });

  it('derives the exponent from the currency rather than configuring it twice', async () => {
    const res = await request(app.getHttpServer()).get(api('/store/config')).expect(200);

    // The whole point of the endpoint: a client must never assume 100. If this
    // ever disagrees with Money, prices are wrong by a power of ten.
    expect(res.body.data.minorUnitExponent).toBe(minorUnitExponent(res.body.data.currency));
  });

  it('reports an exponent a client can convert with', async () => {
    const res = await request(app.getHttpServer()).get(api('/store/config')).expect(200);
    const { minorUnitExponent: exponent } = res.body.data;

    // What the dashboard actually does with the value.
    const typed = '24.99';
    const [whole, fraction = ''] = typed.split('.');
    const minor =
      exponent === 0
        ? Number(whole)
        : Number(whole + `${fraction}${'0'.repeat(exponent)}`.slice(0, exponent));

    expect(minor).toBe(2499);
  });

  it('agrees with the currency the catalogue prices itself in', async () => {
    const config = await request(app.getHttpServer()).get(api('/store/config')).expect(200);
    const products = await request(app.getHttpServer())
      .get(api('/products?limit=1'))
      .expect(200);

    // Nothing enforces this at runtime, so it is worth a test: a client reading
    // the exponent from one place and the amount from another must be safe.
    const item = products.body.data.items[0];
    if (item) {
      expect(item.price.currency).toBe(config.body.data.currency);
    }
  });
});
