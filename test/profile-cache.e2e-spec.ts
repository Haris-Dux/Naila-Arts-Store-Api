import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';

import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createTestApp } from './setup-app';

/**
 * The signed-in customer's profile is cached for a day, so every way it can
 * change must retire it at once — and one customer must never see another's.
 *
 * "Behind the cache" writes go straight to MongoDB, bypassing the service: a
 * cached read does not notice them, which is how these tests tell a cache hit
 * from a database read.
 */
describe('Profile cache (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let userModel: Model<UserDocument>;

  const password = 'StrongP@ssw0rd!';

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

  const http = () => request(app.getHttpServer());

  const signUp = async (email: string, role = UserRole.USER) => {
    const registered = await http()
      .post(api('/auth/register'))
      .send({ name: 'Ayesha Khan', email, password })
      .expect(201);
    const id = registered.body.data.user.id as string;
    if (role !== UserRole.USER) await userModel.updateOne({ _id: id }, { $set: { role } });

    const login = await http().post(api('/auth/login')).send({ email, password }).expect(200);
    return { id, token: login.body.data.tokens.accessToken as string };
  };

  const me = (token: string) =>
    http().get(api('/auth/me')).set('Authorization', `Bearer ${token}`).expect(200);

  const behindTheCache = (id: string, set: Record<string, unknown>) =>
    userModel.updateOne({ _id: id }, { $set: set });

  it('serves the signed-in profile from the cache', async () => {
    const { id, token } = await signUp('ayesha@example.com');
    await me(token);

    await behindTheCache(id, { name: 'Changed Behind The Cache' });

    expect((await me(token)).body.data.name).toBe('Ayesha Khan');
  });

  it('refreshes /auth/me and /users/me as soon as the customer edits their profile', async () => {
    const { id, token } = await signUp('ayesha@example.com');
    await me(token);
    await http().get(api('/users/me')).set('Authorization', `Bearer ${token}`).expect(200);
    await behindTheCache(id, { name: 'Changed Behind The Cache' });

    await http()
      .patch(api('/users/me'))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ayesha K.', birthdate: '1995-04-18' })
      .expect(200);

    expect((await me(token)).body.data).toMatchObject({
      name: 'Ayesha K.',
      birthdate: '1995-04-18',
    });
    const viaUsers = await http()
      .get(api('/users/me'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(viaUsers.body.data.name).toBe('Ayesha K.');
  });

  it('never shows one customer another customer’s cached profile', async () => {
    const ayesha = await signUp('ayesha@example.com');
    const bilal = await signUp('bilal@example.com');
    await userModel.updateOne({ _id: bilal.id }, { $set: { name: 'Bilal Ahmed' } });

    // Both through the same `me` alias, one after the other.
    expect((await me(ayesha.token)).body.data.email).toBe('ayesha@example.com');
    expect((await me(bilal.token)).body.data).toMatchObject({
      email: 'bilal@example.com',
      name: 'Bilal Ahmed',
    });
    expect((await me(ayesha.token)).body.data.email).toBe('ayesha@example.com');
  });

  it('only retires the account that changed', async () => {
    const ayesha = await signUp('ayesha@example.com');
    const bilal = await signUp('bilal@example.com');
    await me(ayesha.token);
    await me(bilal.token);
    await behindTheCache(bilal.id, { name: 'Changed Behind The Cache' });

    await http()
      .patch(api('/users/me'))
      .set('Authorization', `Bearer ${ayesha.token}`)
      .send({ name: 'Ayesha K.' })
      .expect(200);

    // Bilal's entry was not touched by Ayesha's edit.
    expect((await me(bilal.token)).body.data.name).toBe('Ayesha Khan');
  });

  it("shows an admin's role and status change on the profile at once", async () => {
    const admin = await signUp('admin@example.com', UserRole.ADMIN);
    const customer = await signUp('ayesha@example.com');
    const asAdmin = (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${admin.token}`).expect(200);
    await asAdmin(`/users/${customer.id}`);

    await http()
      .patch(api(`/users/${customer.id}/access`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ role: UserRole.ADMIN })
      .expect(200);
    expect((await asAdmin(`/users/${customer.id}`)).body.data.role).toBe(UserRole.ADMIN);

    await http()
      .patch(api(`/users/${customer.id}/access`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false })
      .expect(200);
    expect((await asAdmin(`/users/${customer.id}`)).body.data.isActive).toBe(false);
  });

  it('stops resolving a deleted account at once', async () => {
    const admin = await signUp('admin@example.com', UserRole.ADMIN);
    const customer = await signUp('ayesha@example.com');
    await http()
      .get(api(`/users/${customer.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    await http()
      .delete(api(`/users/${customer.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    await http()
      .get(api(`/users/${customer.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('treats an upper-case spelling of the id as the same account', async () => {
    const admin = await signUp('admin@example.com', UserRole.ADMIN);
    const customer = await signUp('ayesha@example.com');
    const upper = customer.id.toUpperCase();
    const asAdmin = (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${admin.token}`).expect(200);

    // Cached under the canonical id even though it was asked for in upper case…
    await asAdmin(`/users/${upper}`);
    await http()
      .patch(api(`/users/${customer.id}`))
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'Renamed By Admin' })
      .expect(200);

    // …so the edit, which retires the canonical id, retires what it serves too.
    expect((await asAdmin(`/users/${upper}`)).body.data.name).toBe('Renamed By Admin');
  });

  it('never caches a lookup that failed', async () => {
    const admin = await signUp('admin@example.com', UserRole.ADMIN);
    const asAdmin = (path: string) =>
      http().get(api(path)).set('Authorization', `Bearer ${admin.token}`);

    await asAdmin('/users/not-an-id').expect(404);
    await asAdmin('/users/507f1f77bcf86cd799439011').expect(404);
  });
});
