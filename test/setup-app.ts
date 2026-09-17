import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

export interface TestContext {
  app: INestApplication;
  replSet: MongoMemoryReplSet;
  close: () => Promise<void>;
}

/**
 * Boots the real application against an in-memory MongoDB.
 *
 * A *replica set*, not a standalone — the same reason production needs one:
 * transactions. Testing against a standalone would pass today and break the
 * moment checkout lands in Phase 5.
 */
export async function createTestApp(): Promise<TestContext> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = replSet.getUri('store_test');
  process.env.JWT_SECRET = 'test-secret-that-is-definitely-long-enough-32';
  process.env.ACCESS_TOKEN_TTL = '15m';
  process.env.REFRESH_TOKEN_TTL = '30d';
  // Lowest bcrypt cost the config allows — this suite hashes a lot.
  process.env.PASSWORD_SALT_ROUNDS = '10';
  process.env.SMTP_HOST = 'localhost';
  process.env.SMTP_PORT = '1025';
  process.env.MAIL_FROM = 'Test <test@example.com>';
  process.env.STORE_SUPPORT_EMAIL = 'support@example.com';
  process.env.STORE_CURRENCY = 'USD';
  // Pinned like the currency, and for the same reason: without it the suite
  // inherits whatever `.env` says and date-bucketing assertions shift by the
  // deployment's UTC offset. The zone maths itself — DST boundaries, local
  // midnight, month steps — is covered by analytics-window.spec.ts, which does
  // not need a server.
  process.env.STORE_TIMEZONE = 'UTC';
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-webhook-secret-long-enough';
  // Uploads are written for real, into a directory the suite owns and removes.
  // Pinned like the currency and timezone: the suite must never reach for
  // network storage or credentials, whatever `.env` happens to say.
  process.env.MEDIA_DRIVER = 'local';
  process.env.MEDIA_ROOT = './var/media-test';
  process.env.MEDIA_PUBLIC_PATH = '/media';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  // rawBody mirrors main.ts — payment webhook signatures need the exact bytes.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });

  // Mirrors main.ts, including the order: static assets are mounted *before*
  // the global prefix, so an image request never enters the guard chain. Serving
  // them after would put the throttler in front of every thumbnail.
  // Mirrors main.ts, which mounts this only for the local driver — pinned above.
  await mkdir(process.env.MEDIA_ROOT, { recursive: true });
  app.useStaticAssets(resolve(process.env.MEDIA_ROOT), {
    prefix: process.env.MEDIA_PUBLIC_PATH,
    immutable: true,
    maxAge: '365d',
    index: false,
    // A miss falls through to the router, so it comes back as the same JSON
    // 404 as everything else. Only misses pay for the guard chain; a hit is
    // still served and finished before Nest sees it.
    fallthrough: true,
    dotfiles: 'deny',
  });

  // Mirrors main.ts. If these diverge, the suite stops testing what ships.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/liveness'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );
  // ResponseInterceptor comes from APP_INTERCEPTOR in AppModule; adding it here
  // too would double-wrap every response.
  app.useGlobalFilters(new AllExceptionsFilter(false));

  await app.init();

  return {
    app,
    replSet,
    close: async () => {
      await app.close();
      await replSet.stop();
    },
  };
}

export const api = (path: string) => `/api/v1${path}`;

/**
 * A top-level category to file test products under.
 *
 * Every product needs one, so almost every suite needs a category before it can
 * create anything. Repeated calls are safe: the slug is uniquified per live
 * category, so suites that do not reset the collection between tests still get a
 * fresh id each time.
 */
export async function createCategory(
  app: INestApplication,
  adminToken: string,
  name = 'Test Category',
): Promise<string> {
  const created = await request(app.getHttpServer())
    .post(api('/categories'))
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name })
    .expect(201);

  return created.body.data.id as string;
}
