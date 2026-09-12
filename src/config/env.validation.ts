import * as Joi from 'joi';

/**
 * Boot fails loudly on a missing or malformed variable rather than surfacing as
 * `undefined` deep inside a request (the failure mode of the old services, where
 * SMTP_* was absent from .env.template entirely and only failed at send time).
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().default(3000),
  // The only sites allowed to call the API from a browser. Explicit origins, not
  // "*": the API sends credentials (the guest-checkout cookie), and browsers
  // refuse a credentialed response to a wildcard origin.
  CORS_ORIGINS: Joi.string()
    .default('http://localhost:3000')
    .custom((value: string, helpers) => {
      const origins = value
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean);
      const valid = origins.length > 0 && origins.every((o) => /^https?:\/\/[^/\s*]+$/.test(o));
      return valid ? value : helpers.error('any.invalid');
    })
    .messages({
      'any.invalid':
        'CORS_ORIGINS must be a comma-separated list of origins such as https://nailaarts.pk — ' +
        'scheme and host only, no paths and no "*"',
    }),
  PUBLIC_URL: Joi.string().uri().default('http://localhost:3000'),
  // Distinct from JWT_SECRET: one secret, one purpose, so rotating the cookie
  // signing key does not invalidate every access token.
  COOKIE_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'COOKIE_SECRET must be at least 32 characters',
  }),

  MONGO_URI: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().min(0).default(0),

  JWT_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'JWT_SECRET must be at least 32 characters',
  }),
  ACCESS_TOKEN_TTL: Joi.string().default('15m'),
  REFRESH_TOKEN_TTL: Joi.string().default('30d'),
  PASSWORD_SALT_ROUNDS: Joi.number().min(10).max(15).default(12),

  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_SECURE: Joi.boolean().default(false),
  // The shop's Hostinger mailbox needs its login. Required everywhere but the
  // test suite (which never sends), so a missing credential stops startup
  // instead of failing at the first order.
  SMTP_USER: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().required(),
  }),
  SMTP_PASS: Joi.string().when('NODE_ENV', {
    is: 'test',
    then: Joi.string().allow('').optional(),
    otherwise: Joi.string().required(),
  }),
  MAIL_FROM: Joi.string().required(),

  // `local` keeps files on the deployment's own disk; `r2` puts them in
  // Cloudflare R2. The R2 credentials below are required only in that case, so a
  // developer running on disk is never asked to invent them.
  MEDIA_DRIVER: Joi.string().valid('local', 'r2').default('local'),

  // Absolute in a container, where it is a mounted volume; relative is fine for
  // local development.
  MEDIA_ROOT: Joi.string().default('./var/media'),
  MEDIA_PUBLIC_PATH: Joi.string()
    .pattern(/^\/[a-z0-9\-/]*$/)
    .default('/media'),

  // Conditionally required: missing R2 credentials must fail at boot, not on the
  // first upload, but only when R2 is the selected driver.
  R2_ACCOUNT_ID: Joi.string().when('MEDIA_DRIVER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_ACCESS_KEY_ID: Joi.string().when('MEDIA_DRIVER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_SECRET_ACCESS_KEY: Joi.string().when('MEDIA_DRIVER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_BUCKET: Joi.string().when('MEDIA_DRIVER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  // Validated as a real URL rather than a path: this is an absolute origin the
  // browser fetches directly, so MEDIA_PUBLIC_PATH's leading-slash pattern would
  // reject exactly the value that is correct here.
  R2_PUBLIC_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .when('MEDIA_DRIVER', {
      is: 'r2',
      then: Joi.required(),
      otherwise: Joi.optional().allow(''),
    })
    .messages({
      'string.uri': 'R2_PUBLIC_URL must be an absolute URL, e.g. https://cdn.example.com',
    }),

  STORE_CURRENCY: Joi.string().length(3).uppercase().default('USD'),
  STORE_NAME: Joi.string().default('Store'),
  STORE_SUPPORT_EMAIL: Joi.string().email().required(),
  STORE_LOCALE: Joi.string().default('en'),
  // Probed rather than pattern-matched: a typo like 'Asia/Karach' is a valid
  // looking string that Intl rejects, and finding that out at boot beats finding
  // it out when the first analytics request silently falls back to UTC.
  STORE_TIMEZONE: Joi.string()
    .default('UTC')
    .custom((value: string, helpers) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    })
    .messages({ 'any.invalid': 'STORE_TIMEZONE must be an IANA zone, e.g. Asia/Karachi' }),

  // Verifies provider webhooks. A weak value here means anyone who guesses it
  // can mark any order paid, so it is held to the same bar as JWT_SECRET.
  PAYMENT_WEBHOOK_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'PAYMENT_WEBHOOK_SECRET must be at least 32 characters',
  }),
  PAYMENT_WEBHOOK_TOLERANCE_SECONDS: Joi.number().min(30).max(3600).default(300),
  PAYMENT_BANK_NAME: Joi.string().default('Example Bank'),
  PAYMENT_ACCOUNT_NAME: Joi.string().default('Example Store Ltd'),
  PAYMENT_ACCOUNT_NUMBER: Joi.string().default('GB00EXAM00000000000000'),

  // The first administrator, created at startup when none exists (see
  // AdminSeedService). Optional here: once an administrator exists they are
  // never read, and a production start with no administrator and no values
  // fails there, with a clearer message than a validation error.
  SEED_ADMIN_EMAIL: Joi.string().email().allow('').optional(),
  SEED_ADMIN_PASSWORD: Joi.string().allow('').optional(),
  SEED_ADMIN_NAME: Joi.string().default('Administrator'),
});
