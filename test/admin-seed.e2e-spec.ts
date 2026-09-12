import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';

import { AdminSeedService } from '../src/modules/users/admin-seed.service';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createTestApp } from './setup-app';

/**
 * The first administrator, created at startup on a database that has none.
 *
 * With no migrations this is the only way an ADMIN comes into being, so what it
 * must refuse to do matters as much as what it does.
 */
describe('First administrator (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let userModel: Model<UserDocument>;
  let seed: AdminSeedService;
  let config: ConfigService;

  const email = 'owner@nailaarts.example';
  const password = 'Seed-Admin-P4ss!';

  beforeAll(async () => {
    process.env.SEED_ADMIN_EMAIL = email;
    process.env.SEED_ADMIN_PASSWORD = password;
    process.env.SEED_ADMIN_NAME = 'Shop Owner';
    ctx = await createTestApp();
    app = ctx.app;
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    seed = app.get(AdminSeedService);
    config = app.get(ConfigService);
  }, 120_000);

  afterAll(async () => {
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
    delete process.env.SEED_ADMIN_NAME;
    await ctx?.close();
  });

  beforeEach(async () => {
    await userModel.deleteMany({});
    jest.restoreAllMocks();
  });

  /** Run the seed as if the environment said something else. */
  const withConfig = (overrides: Record<string, unknown>) => {
    const original = config.getOrThrow.bind(config);
    jest
      .spyOn(config, 'getOrThrow')
      .mockImplementation((key: string) => (key in overrides ? overrides[key] : original(key)));
  };

  const admins = () => userModel.countDocuments({ role: UserRole.ADMIN });

  it('creates the administrator on a database that has none, able to sign in', async () => {
    expect(await seed.ensureAdmin()).toBe('created');

    const admin = await userModel.findOne({ email }).select('+password').lean().exec();
    expect(admin?.role).toBe(UserRole.ADMIN);
    expect(admin?.name).toBe('Shop Owner');
    expect(admin?.password).not.toBe(password);

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password })
      .expect(200);
    expect(login.body.data.user.role).toBe(UserRole.ADMIN);
  });

  it('does nothing once an administrator exists', async () => {
    await seed.ensureAdmin();

    expect(await seed.ensureAdmin()).toBe('exists');
    expect(await admins()).toBe(1);
  });

  it('leaves the store alone when a different administrator already exists', async () => {
    await userModel.create({
      name: 'Existing Admin',
      email: 'someone.else@nailaarts.example',
      password: 'not-a-real-hash',
      role: UserRole.ADMIN,
    });

    expect(await seed.ensureAdmin()).toBe('exists');
    expect(await userModel.exists({ email })).toBeNull();
  });

  it('never promotes a customer who registered with the seed address', async () => {
    await request(app.getHttpServer())
      .post(api('/auth/register'))
      .send({ name: 'A Customer', email, password: 'Cust0mer-P4ss!' })
      .expect(201);

    expect(await seed.ensureAdmin()).toBe('skipped');
    expect((await userModel.findOne({ email }).lean().exec())?.role).toBe(UserRole.USER);
    expect(await admins()).toBe(0);
  });

  it('creates exactly one administrator when two instances start together', async () => {
    const outcomes = await Promise.all([seed.ensureAdmin(), seed.ensureAdmin()]);

    expect(outcomes.sort()).toEqual(['created', 'exists']);
    expect(await admins()).toBe(1);
  });

  it('refuses a weak password', async () => {
    withConfig({ seed: { adminEmail: email, adminPassword: 'weak', adminName: 'Owner' } });

    await expect(seed.ensureAdmin()).rejects.toThrow(/SEED_ADMIN_PASSWORD/);
    expect(await admins()).toBe(0);
  });

  it('only warns outside production when no credentials are set', async () => {
    withConfig({ seed: { adminName: 'Owner' } });

    expect(await seed.ensureAdmin()).toBe('skipped');
  });

  it('stops a production start that has no administrator and no credentials', async () => {
    withConfig({ seed: { adminName: 'Owner' }, 'app.env': 'production' });

    await expect(seed.ensureAdmin()).rejects.toThrow(/nobody can sign in/);
  });
});
