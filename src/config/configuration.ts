/**
 * Typed configuration. Every value here is validated at boot by `envValidationSchema`,
 * so `ConfigService.get<T>()` never returns undefined for a declared key.
 */
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  corsOrigins: string[];
  /** Public-facing base URL, used in emails and payment redirects. */
  publicUrl: string;
  /** Signs the guest-identity cookie. Separate from JWT_SECRET on purpose. */
  cookieSecret: string;
}

/** Where uploaded bytes live. */
export type MediaDriver = 'local' | 'r2';

export interface R2Config {
  /** Cloudflare account id — the host part of the S3 endpoint. */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Base URL the bucket is publicly readable at, no trailing slash.
   *
   * A custom domain in production. Reads never go through this application, so
   * this is what a stored image URL is built from — and because every filename
   * is a content hash, those URLs are immutable and cacheable forever.
   */
  publicUrl: string;
}

export interface MediaConfig {
  /**
   * `local` writes to the deployment's own disk and serves the files through
   * Express; `r2` puts them in Cloudflare R2 and serves them from its CDN.
   *
   * Kept as a switch rather than a replacement because the test suite must not
   * need network or credentials — it runs on `local` against a scratch
   * directory it owns.
   */
  driver: MediaDriver;
  /**
   * Directory uploaded images are written to, when `driver` is `local`.
   *
   * Must be a mounted volume in a container, or a rebuild takes the catalogue's
   * photography with it, and must be backed up separately from Mongo — a
   * database dump restores everything except the pictures.
   */
  root: string;
  /** URL prefix the local files are served under. Ignored by the R2 driver. */
  publicPath: string;
  /** Only read when `driver` is `r2`; the validator requires it in that case. */
  r2: R2Config;
}

export interface DatabaseConfig {
  uri: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
}

export interface AuthConfig {
  jwtSecret: string;
  accessTokenTtl: string;
  refreshTokenTtl: string;
  passwordSaltRounds: number;
}

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface StoreConfig {
  /** ISO 4217 code. Drives formatting and the minor-unit exponent. */
  currency: string;
  name: string;
  supportEmail: string;
  /** Default email language when the recipient has no preference. */
  locale: string;
  /**
   * IANA zone the merchant's day is measured in ("Asia/Karachi").
   *
   * Analytics day and month buckets are cut here rather than in UTC. For a store
   * at UTC+5 a UTC day runs 05:00 to 05:00 local, so every order placed between
   * midnight and 5am would land on the previous day's figures, and "today" would
   * be missing its first five hours. Defaults to UTC, which reproduces the
   * naive behaviour exactly.
   */
  timezone: string;
}

/**
 * The store's first administrator, created at startup when the database has
 * none. Ignored once any administrator exists.
 */
export interface SeedConfig {
  adminEmail?: string;
  adminPassword?: string;
  adminName: string;
}

export interface PaymentsConfig {
  /** HMAC key for verifying provider webhooks. */
  webhookSecret: string;
  /** How far a webhook timestamp may drift before it is rejected as a replay. */
  webhookToleranceSeconds: number;
  // Shown to the customer for a bank transfer.
  bankName: string;
  accountName: string;
  accountNumber: string;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  mail: MailConfig;
  store: StoreConfig;
  media: MediaConfig;
  payments: PaymentsConfig;
  seed: SeedConfig;
}

export const configuration = (): Configuration => ({
  app: {
    env: process.env.NODE_ENV as AppConfig['env'],
    port: parseInt(process.env.PORT as string, 10),
    // A trailing slash never matches: browsers send the Origin header without one.
    corsOrigins: (process.env.CORS_ORIGINS as string)
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    publicUrl: process.env.PUBLIC_URL as string,
    cookieSecret: process.env.COOKIE_SECRET as string,
  },
  database: {
    uri: process.env.MONGO_URI as string,
  },
  redis: {
    host: process.env.REDIS_HOST as string,
    port: parseInt(process.env.REDIS_PORT as string, 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB as string, 10),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET as string,
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL as string,
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL as string,
    passwordSaltRounds: parseInt(process.env.PASSWORD_SALT_ROUNDS as string, 10),
  },
  mail: {
    host: process.env.SMTP_HOST as string,
    port: parseInt(process.env.SMTP_PORT as string, 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.MAIL_FROM as string,
  },
  media: {
    driver: process.env.MEDIA_DRIVER as MediaDriver,
    root: process.env.MEDIA_ROOT as string,
    publicPath: process.env.MEDIA_PUBLIC_PATH as string,
    r2: {
      accountId: process.env.R2_ACCOUNT_ID as string,
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
      bucket: process.env.R2_BUCKET as string,
      // Trailing slash trimmed here so `urlFor` can always join with one.
      publicUrl: (process.env.R2_PUBLIC_URL as string)?.replace(/\/+$/, ''),
    },
  },
  store: {
    currency: process.env.STORE_CURRENCY as string,
    name: process.env.STORE_NAME as string,
    supportEmail: process.env.STORE_SUPPORT_EMAIL as string,
    locale: process.env.STORE_LOCALE as string,
    timezone: process.env.STORE_TIMEZONE as string,
  },
  payments: {
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET as string,
    webhookToleranceSeconds: parseInt(process.env.PAYMENT_WEBHOOK_TOLERANCE_SECONDS as string, 10),
    bankName: process.env.PAYMENT_BANK_NAME as string,
    accountName: process.env.PAYMENT_ACCOUNT_NAME as string,
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER as string,
  },
  seed: {
    adminEmail: process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || undefined,
    adminPassword: process.env.SEED_ADMIN_PASSWORD || undefined,
    adminName: process.env.SEED_ADMIN_NAME || 'Administrator',
  },
});
