import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createTestApp } from './setup-app';

/**
 * Each case below maps to a specific finding from the audit of the old stack.
 * They exist to prove the fix and to stop it regressing.
 */
describe('Auth & Users (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let userModel: Model<UserDocument>;

  const strongPassword = 'StrongP@ssw0rd!';

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await userModel.deleteMany({});
  });

  const register = (overrides: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: strongPassword,
        ...overrides,
      });

  /** Registers and returns the access token plus the created user's id. */
  const registerAndLogin = async (overrides: Record<string, unknown> = {}) => {
    const res = await register(overrides).expect(201);
    return {
      accessToken: res.body.data.tokens.accessToken as string,
      refreshToken: res.body.data.tokens.refreshToken as string,
      userId: res.body.data.user.id as string,
    };
  };

  const promote = async (userId: string, role: UserRole) => {
    await userModel.updateOne({ _id: userId }, { $set: { role } });
  };

  // ------------------------------------------------------------------ C1

  describe('privilege assignment (C1)', () => {
    it('gives admin@admin.com the ordinary USER role', async () => {
      // The old service hardcoded `email === 'admin@admin.com' ? SUPER_ADMIN : USER`
      // on an unauthenticated route — a one-request takeover.
      const res = await register({ email: 'admin@admin.com' }).expect(201);
      expect(res.body.data.user.role).toBe(UserRole.USER);
    });

    it('rejects a role supplied at registration', async () => {
      await register({ role: UserRole.ADMIN }).expect(400);
    });

    it('exposes no public user-creation route', async () => {
      // Account creation lives only at /auth/register; POST /users is gone.
      await request(app.getHttpServer())
        .post(api('/users'))
        .send({ name: 'X', email: 'x@example.com', password: strongPassword })
        .expect(404);
    });
  });

  // ------------------------------------------------------------------ C2

  describe('privilege escalation via profile update (C2)', () => {
    it('rejects a role change through the self-service profile route', async () => {
      const { accessToken, userId } = await registerAndLogin();

      await request(app.getHttpServer())
        .patch(api(`/users/${userId}`))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ role: UserRole.ADMIN })
        .expect(400);

      const after = await userModel.findById(userId).exec();
      expect(after?.role).toBe(UserRole.USER);
    });

    it('rejects isActive and tokenVersion on the profile route', async () => {
      const { accessToken, userId } = await registerAndLogin();

      await request(app.getHttpServer())
        .patch(api(`/users/${userId}`))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isActive: false, tokenVersion: 99 })
        .expect(400);
    });

    it('lets a user change their own name', async () => {
      const { accessToken, userId } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .patch(api(`/users/${userId}`))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Jane Updated' })
        .expect(200);

      expect(res.body.data.name).toBe('Jane Updated');
    });

    it('stops a customer from granting themselves a role', async () => {
      const { accessToken, userId } = await registerAndLogin();

      // The access route is admin-only; a customer cannot reach it at all.
      await request(app.getHttpServer())
        .patch(api(`/users/${userId}/access`))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ role: UserRole.ADMIN })
        .expect(403);
    });

    it('lets an admin appoint another admin', async () => {
      // With two peer roles this has to work, or the store is stuck forever with
      // whichever single administrator the seed migration created.
      const admin = await registerAndLogin({ email: 'admin@example.com' });
      await promote(admin.userId, UserRole.ADMIN);
      const target = await registerAndLogin({ email: 'target@example.com' });

      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'admin@example.com', password: strongPassword })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(api(`/users/${target.userId}/access`))
        .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
        .send({ role: UserRole.ADMIN })
        .expect(200);

      expect(res.body.data.role).toBe(UserRole.ADMIN);
    });
  });

  // ------------------------------------------------------------------ C3

  describe('authentication is required by default (C3)', () => {
    it.each([
      ['get', '/users'],
      ['get', '/users/me'],
      ['patch', '/users/me'],
      ['get', '/auth/me'],
      ['post', '/auth/logout-all'],
    ])('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const res = await request(app.getHttpServer())[method as 'get'](api(path)).send({});
      expect(res.status).toBe(401);
    });

    it('rejects a malformed bearer token', async () => {
      await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  // ------------------------------------------------------------------ C7

  describe('request validation (C7)', () => {
    it('rejects an unknown field', async () => {
      await register({ isAdmin: true }).expect(400);
    });

    it('rejects a malformed email', async () => {
      await register({ email: 'not-an-email' }).expect(400);
    });

    it('rejects a weak password', async () => {
      await register({ password: 'password' }).expect(400);
    });

    it('reports validation failures with a usable code and details', async () => {
      const res = await register({ email: 'nope' }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.details)).toBe(true);
    });
  });

  // ------------------------------------------------------------------ C8

  describe('password handling (C8, C9)', () => {
    it('stores a bcrypt hash, never the plaintext', async () => {
      const { userId } = await registerAndLogin();
      const stored = await userModel.findById(userId).select('+password').exec();

      expect(stored?.password).not.toBe(strongPassword);
      expect(stored?.password).toMatch(/^\$2[aby]\$\d{2}\$/);
    });

    it('hashes on change, and the new password works', async () => {
      const { accessToken, userId } = await registerAndLogin();
      const newPassword = 'EvenStr0nger@Pass!';

      await request(app.getHttpServer())
        .post(api('/auth/change-password'))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: strongPassword, newPassword })
        .expect(204);

      const stored = await userModel.findById(userId).select('+password').exec();
      expect(stored?.password).not.toBe(newPassword);
      expect(stored?.password).toMatch(/^\$2[aby]\$\d{2}\$/);

      await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: newPassword })
        .expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword })
        .expect(401);
    });

    it('refuses a password change without the correct current password', async () => {
      const { accessToken } = await registerAndLogin();

      await request(app.getHttpServer())
        .post(api('/auth/change-password'))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'WrongP@ssw0rd!', newPassword: 'EvenStr0nger@Pass!' })
        .expect(401);
    });

    it('never returns a password field from any user endpoint', async () => {
      const { userId } = await registerAndLogin();
      await promote(userId, UserRole.ADMIN);

      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword })
        .expect(200);
      const adminToken = login.body.data.tokens.accessToken as string;

      const responses = await Promise.all([
        request(app.getHttpServer())
          .get(api('/auth/me'))
          .set('Authorization', `Bearer ${adminToken}`),
        request(app.getHttpServer())
          .get(api('/users'))
          .set('Authorization', `Bearer ${adminToken}`),
        request(app.getHttpServer())
          .get(api(`/users/${userId}`))
          .set('Authorization', `Bearer ${adminToken}`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      }
    });
  });

  // ------------------------------------------------------------------ B2

  describe('GET /users/:id works (B2)', () => {
    it('returns the user by id', async () => {
      const { accessToken, userId } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .get(api(`/users/${userId}`))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(userId);
      expect(res.body.data.email).toBe('jane@example.com');
    });

    it('resolves the "me" alias', async () => {
      const { accessToken, userId } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .get(api('/users/me'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.data.id).toBe(userId);
    });

    it('returns 404, not 500, for a well-formed but unknown id', async () => {
      const { userId } = await registerAndLogin();
      await promote(userId, UserRole.ADMIN);
      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword });

      const res = await request(app.getHttpServer())
        .get(api('/users/507f1f77bcf86cd799439011'))
        .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns 404, not 500, for a malformed id', async () => {
      const { userId } = await registerAndLogin();
      await promote(userId, UserRole.ADMIN);
      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword });

      // A raw CastError would have surfaced as a 500.
      const res = await request(app.getHttpServer())
        .get(api('/users/not-an-object-id'))
        .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

      expect(res.status).toBe(404);
    });

    it("forbids reading another user's record", async () => {
      const jane = await registerAndLogin();
      const bob = await registerAndLogin({ email: 'bob@example.com' });

      await request(app.getHttpServer())
        .get(api(`/users/${bob.userId}`))
        .set('Authorization', `Bearer ${jane.accessToken}`)
        .expect(403);
    });
  });

  // ------------------------------------------------------------------ B4

  describe('optional birthdate (B4)', () => {
    it('registers without a birthdate', async () => {
      // The old flow ran a DD/MM/YYYY-only pipe unconditionally on an optional
      // field, so omitting it threw on `undefined.split()`.
      const res = await register().expect(201);
      expect(res.body.data.user.birthdate).toBeNull();
    });

    it('accepts an ISO 8601 birthdate', async () => {
      const res = await register({ birthdate: '1990-01-31' }).expect(201);
      expect(res.body.data.user.birthdate).toBe('1990-01-31');
    });

    it('rejects a non-ISO birthdate rather than mangling it', async () => {
      await register({ birthdate: '31/01/1990' }).expect(400);
    });
  });

  // ------------------------------------------------------------------ C6

  describe('sort allow-list (C6)', () => {
    it('rejects a sort field that is not on the allow-list', async () => {
      const { userId } = await registerAndLogin();
      await promote(userId, UserRole.ADMIN);
      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword });
      const token = login.body.data.tokens.accessToken as string;

      await request(app.getHttpServer())
        .get(api('/users?sort=password'))
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(api('/users?sort=createdAt'))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  // ------------------------------------------------------------------ A10

  describe('token lifecycle (A9, A10)', () => {
    it('carries role and tokenVersion in the access token, so guards need no lookup', async () => {
      const { accessToken } = await registerAndLogin();
      const claims = JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
      ) as Record<string, unknown>;

      expect(claims.role).toBe(UserRole.USER);
      expect(claims.tokenVersion).toBe(0);
      expect(claims.sub).toBeDefined();
      expect(claims).not.toHaveProperty('password');
    });

    it('rotates the refresh token and spends the old one', async () => {
      const { refreshToken } = await registerAndLogin();

      const first = await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken })
        .expect(200);

      const rotated = first.body.data.refreshToken as string;
      expect(rotated).not.toBe(refreshToken);

      // The rotated token works.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: rotated })
        .expect(200);
    });

    it('treats reuse of a spent refresh token as theft and kills the family', async () => {
      const { refreshToken } = await registerAndLogin();

      const first = await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken })
        .expect(200);
      const rotated = first.body.data.refreshToken as string;

      // Replaying the original — an attacker with a stolen copy.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken })
        .expect(401);

      // …which also invalidates the legitimate holder's current token, forcing
      // a real re-login rather than letting the thief ride the chain.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: rotated })
        .expect(401);
    });

    it('revokes a single session on logout', async () => {
      const { accessToken, refreshToken } = await registerAndLogin();

      await request(app.getHttpServer())
        .post(api('/auth/logout'))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken })
        .expect(401);
    });

    it('revokes every session and invalidates live access tokens on logout-all', async () => {
      const { accessToken, refreshToken } = await registerAndLogin();

      const second = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword })
        .expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/logout-all'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Both refresh tokens are dead.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: second.body.data.tokens.refreshToken })
        .expect(401);

      // And the already-issued access token stops working immediately, rather
      // than lingering until it expires.
      await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('does not mint a new token from GET /auth/me', async () => {
      // The old /auth/me re-signed a fresh 1-day token from a valid one, so a
      // leaked token could be renewed forever.
      const { accessToken } = await registerAndLogin();

      const res = await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(JSON.stringify(res.body)).not.toMatch(/accessToken|access_token/);
    });
  });

  describe('login', () => {
    it('returns the same error for an unknown email and a wrong password', async () => {
      await registerAndLogin();

      const unknown = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'nobody@example.com', password: strongPassword })
        .expect(401);

      const wrong = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: 'WrongP@ssw0rd!' })
        .expect(401);

      // Distinguishing them would let an attacker enumerate registered addresses.
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('refuses a deactivated account', async () => {
      const { userId } = await registerAndLogin();
      await userModel.updateOne({ _id: userId }, { $set: { isActive: false } });

      await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword })
        .expect(401);
    });

    it('rejects a duplicate registration with 409, not 500', async () => {
      await registerAndLogin();
      const res = await register().expect(409);
      expect(res.body.code).toBe('CONFLICT');
    });
  });

  describe('admin access control', () => {
    it('stops a plain user from listing users', async () => {
      const { accessToken } = await registerAndLogin();

      await request(app.getHttpServer())
        .get(api('/users'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('refuses to remove the last administrator', async () => {
      const { userId } = await registerAndLogin();
      await promote(userId, UserRole.ADMIN);

      const login = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: 'jane@example.com', password: strongPassword });
      const token = login.body.data.tokens.accessToken as string;

      const res = await request(app.getHttpServer())
        .delete(api(`/users/${userId}`))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/last active administrator/i);
    });
  });
});
