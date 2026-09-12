import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppConfig, MediaConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Defer logging until the Pino logger is wired, so startup lines are
    // structured too.
    bufferLogs: true,
    // Keeps the unparsed body on `req.rawBody`. Payment webhook signatures are
    // computed over the exact bytes sent, and re-serialising parsed JSON does
    // not reproduce them.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const { env, port, corsOrigins } = config.getOrThrow<AppConfig>('app');
  const isProduction = env === 'production';

  // Behind a load balancer or ingress: trust the proxy so rate limiting and
  // logging see the real client IP rather than the proxy's.
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: isProduction ? undefined : false }));
  app.use(compression());
  // Signed cookies carry the guest token, so a client cannot claim another
  // guest's order by editing the value.
  app.use(cookieParser(config.getOrThrow<string>('app.cookieSecret')));
  // Only the store's own sites, from CORS_ORIGINS. Credentials stay on for the
  // guest-checkout cookie — which is exactly why the list is explicit: browsers
  // refuse a credentialed response to a wildcard origin, and echoing back any
  // caller would let every other website read a guest's orders.
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  /**
   * Uploaded images, straight off the disk — only when the local driver is in
   * use. Under R2 the bytes are served by Cloudflare and this process never sees
   * a read, so mounting a static handler would only add a directory that is
   * always empty.
   *
   * Mounted here — before `setGlobalPrefix`, and therefore before the Nest
   * router — so an image request never enters the guard chain. That matters more
   * than it looks: the throttler is a global guard backed by Redis, so routing
   * images through Nest would put a Redis round trip in front of every thumbnail
   * on every product grid.
   *
   * Every filename is the SHA-256 of its own contents, so a URL's bytes can
   * never change and `immutable` is safe to promise. That promise is what a CDN
   * in front of this needs to stop revalidating, and it is where the read speed
   * actually comes from — far more than the disk underneath.
   */
  const media = config.getOrThrow<MediaConfig>('media');
  if (media.driver === 'local') {
    await mkdir(media.root, { recursive: true });
    app.useStaticAssets(resolve(media.root), {
      prefix: media.publicPath,
      immutable: true,
      maxAge: '365d',
      // Nothing is served from here but files that were uploaded; an index
      // listing or a fallthrough to the API would both be surprises.
      index: false,
      // A miss falls through to the router, so it comes back as the same JSON
      // 404 as everything else. Only misses pay for the guard chain; a hit is
      // still served and finished before Nest sees it.
      fallthrough: true,
      dotfiles: 'deny',
    });
  }

  app.setGlobalPrefix('api', { exclude: ['health', 'health/liveness'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  /**
   * Global validation — the single most important line in this file.
   *
   * The old gateway never registered a ValidationPipe at all, and downstream
   * handlers took untyped destructured payloads, so every class-validator
   * decorator in the shared DTOs was decorative. `whitelist` strips unknown
   * keys and `forbidNonWhitelisted` rejects them outright, which is also what
   * closes the mass-assignment path that let a user set their own role.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Don't echo the rejected payload back in production.
      disableErrorMessages: false,
      validationError: { target: false, value: false },
    }),
  );

  // ResponseInterceptor is NOT registered here — it is provided via APP_INTERCEPTOR
  // in AppModule, which gives it DI. Registering it in both places wraps every
  // response twice, producing `data.data`.
  app.useGlobalFilters(new AllExceptionsFilter(isProduction));

  // Finish in-flight requests and drain queue workers on SIGTERM.
  app.enableShutdownHooks();

  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('E-commerce API')
      .setDescription('Storefront and admin API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true },
      customSiteTitle: 'E-commerce API',
    });
  }

  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`Store listening on port ${port} (${env})`);
}

void bootstrap();
