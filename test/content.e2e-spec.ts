import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import {
  ContentSection,
  ContentSectionDocument,
} from '../src/modules/content/schemas/content-section.schema';
import { SECTION_REGISTRY } from '../src/modules/content/sections';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createTestApp } from './setup-app';

/**
 * Storefront content the client edits themselves.
 *
 * Two things are under test and they are not the same thing. One is the two
 * sections the client asked for — the announcement bar and the homepage banner
 * slider. The other is the framework underneath: that a section is declared, not
 * built, and that the generic route validates each one against its own shape
 * rather than accepting whatever it is sent.
 */
describe('Storefront content (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let sectionModel: Model<ContentSectionDocument>;
  let userModel: Model<UserDocument>;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;

  const BAR = 'announcement_bar';
  const SLIDER = 'home_banner_slider';
  const image = (n: number) => `https://cdn.example.com/banners/${n}.jpg`;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    sectionModel = app.get<Model<ContentSectionDocument>>(getModelToken(ContentSection.name));
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

  beforeEach(async () => {
    await Promise.all([sectionModel.deleteMany({}), userModel.deleteMany({})]);
    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
  });

  // --------------------------------------------------------------- helpers

  const save = (key: string, body: Record<string, unknown>, token = adminToken) =>
    request(app.getHttpServer())
      .put(api(`/content/sections/${key}`))
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const read = (key: string, token?: string) => {
    const req = request(app.getHttpServer()).get(api(`/content/sections/${key}`));
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  // ------------------------------------------------------------- framework

  describe('sections are declared, not built', () => {
    it('serves every registered section from one request', async () => {
      // The storefront fetches its chrome in a single call; a section added to
      // the registry appears here with no route or service change.
      const listed = await request(app.getHttpServer()).get(api('/content/sections')).expect(200);

      expect(listed.body.data.map((s: { key: string }) => s.key)).toEqual(
        SECTION_REGISTRY.map((definition) => definition.key),
      );
    });

    it('serves defaults for a section nobody has edited', async () => {
      // No seeded rows: an unedited section falls back to its definition, so the
      // storefront never has a blank state to handle.
      expect(await sectionModel.countDocuments({})).toBe(0);

      const bar = await read(BAR).expect(200);
      expect(bar.body.data.data.items).toHaveLength(1);
      expect(bar.body.data.updatedAt).toBeNull();

      const slider = await read(SLIDER).expect(200);
      expect(slider.body.data.data.items).toEqual([]);
    });

    it('reports which section it is, for the admin panel to label', async () => {
      const bar = await read(BAR).expect(200);
      expect(bar.body.data.label).toBe('Announcement bar');
      expect(bar.body.data.description).toMatch(/strip/i);
    });

    it('404s an unknown section rather than inventing one', async () => {
      await read('footer_links').expect(404);
      await save('footer_links', { data: { items: [] } }).expect(404);
    });

    it('ignores a stored row whose section no longer exists', async () => {
      // A retired section leaves its data behind. Reads are driven by the
      // registry, so the orphan is inert rather than served as an unknown blob.
      await sectionModel.create({ key: 'retired_section', data: { items: [] } });

      const listed = await request(app.getHttpServer()).get(api('/content/sections')).expect(200);
      expect(listed.body.data.map((s: { key: string }) => s.key)).not.toContain('retired_section');
    });

    it('stores what was sent and nothing else', async () => {
      // No null padding: an optional field the administrator left blank stays
      // out of the document, and `isActive` comes back as a real boolean rather
      // than the null a storefront would read as "hidden".
      await save(SLIDER, {
        data: { items: [{ url: image(1) }, { url: image(2), alt: 'Lawn 2026' }] },
      }).expect(200);

      const stored = await sectionModel.findOne({ key: SLIDER }).lean().exec();
      expect(stored?.data.items).toEqual([
        { url: image(1), isActive: true },
        { url: image(2), alt: 'Lawn 2026', isActive: true },
      ]);
    });

    it('records who last saved a section', async () => {
      await save(BAR, { data: { items: [{ text: 'Free delivery' }] } }).expect(200);

      const stored = await sectionModel.findOne({ key: BAR }).exec();
      expect(stored?.updatedBy).not.toBeNull();
    });

    it('keeps exactly one row per section however often it is saved', async () => {
      for (const text of ['One', 'Two', 'Three']) {
        await save(BAR, { data: { items: [{ text }] } }).expect(200);
      }

      expect(await sectionModel.countDocuments({ key: BAR })).toBe(1);
      const bar = await read(BAR).expect(200);
      expect(bar.body.data.data.items[0].text).toBe('Three');
    });
  });

  // ----------------------------------------------------------- validation

  describe('each section is validated against its own shape', () => {
    it('rejects content that does not match the section', async () => {
      // The generic route must not be the one endpoint on the API that accepts
      // anything, so the registry's DTO is applied with the same strictness the
      // global pipe uses everywhere else.
      const rejected = await save(BAR, { data: { items: [{ text: '' }] } }).expect(400);
      expect(rejected.body.message).toMatch(/not valid/i);
    });

    it('rejects an unknown key inside the content', async () => {
      const rejected = await save(BAR, {
        data: { items: [{ text: 'Hello', colour: 'red' }] },
      }).expect(400);
      expect(JSON.stringify(rejected.body)).toMatch(/colour/);
    });

    it('names the offending entry, not just the field', async () => {
      const rejected = await save(SLIDER, {
        data: { items: [{ url: image(1) }, { url: 'not-a-url' }] },
      }).expect(400);

      // Which of the five banners is wrong is the only thing worth saying.
      expect(JSON.stringify(rejected.body.details)).toMatch(/items\.1/);
    });

    it('rejects a banner that is not an image URL', async () => {
      await save(SLIDER, { data: { items: [{ url: 'javascript:alert(1)' }] } }).expect(400);
    });

    it('rejects content of the wrong shape entirely', async () => {
      await save(BAR, { data: { items: 'a string' } }).expect(400);
      await save(BAR, { data: 'not an object' }).expect(400);
      await save(BAR, {}).expect(400);
    });

    it('does not let one section be saved with another section’s content', async () => {
      // Both are `{ items: [...] }`; only the entry shape tells them apart.
      await save(BAR, { data: { items: [{ url: image(1) }] } }).expect(400);
      await save(SLIDER, { data: { items: [{ text: 'Free delivery' }] } }).expect(400);
    });
  });

  // ----------------------------------------------------- announcement bar

  describe('the announcement bar', () => {
    it('stores several messages and serves them in order', async () => {
      // Array order is display order: the section is one document, replaced
      // whole, so there is no need for an explicit position field.
      await save(BAR, {
        data: {
          items: [
            { text: '✨ Easy Return & Exchange Policy ✨' },
            { text: '✨ Free delivery over Rs. 5000 ✨' },
            { text: '✨ Azadi Sale — up to 50% off ✨' },
          ],
        },
      }).expect(200);

      const bar = await read(BAR).expect(200);
      expect(bar.body.data.data.items.map((i: { text: string }) => i.text)).toEqual([
        '✨ Easy Return & Exchange Policy ✨',
        '✨ Free delivery over Rs. 5000 ✨',
        '✨ Azadi Sale — up to 50% off ✨',
      ]);
    });

    it('hides a message switched off, without losing it', async () => {
      await save(BAR, {
        data: {
          items: [{ text: 'Live message' }, { text: 'Staged for next week', isActive: false }],
        },
      }).expect(200);

      const shopper = await read(BAR).expect(200);
      expect(shopper.body.data.data.items.map((i: { text: string }) => i.text)).toEqual([
        'Live message',
      ]);

      // The admin still sees both — that is what makes it staging rather than
      // deletion.
      const staff = await read(BAR, adminToken).expect(200);
      expect(staff.body.data.data.items).toHaveLength(2);
    });

    it('caps the number of messages', async () => {
      const items = Array.from({ length: 11 }, (_, i) => ({ text: `Message ${i}` }));
      await save(BAR, { data: { items } }).expect(400);
      await save(BAR, { data: { items: items.slice(0, 10) } }).expect(200);
    });

    it('can be emptied', async () => {
      await save(BAR, { data: { items: [] } }).expect(200);
      const bar = await read(BAR).expect(200);
      expect(bar.body.data.data.items).toEqual([]);
    });

    it('can be switched off entirely and back on', async () => {
      await save(BAR, { data: { items: [{ text: 'Hello' }] }, isPublished: false }).expect(200);

      // Gone for a shopper, still there for the admin to switch back on.
      await read(BAR).expect(404);
      const staff = await read(BAR, adminToken).expect(200);
      expect(staff.body.data.isPublished).toBe(false);
      expect(staff.body.data.data.items).toHaveLength(1);

      const listed = await request(app.getHttpServer()).get(api('/content/sections')).expect(200);
      expect(listed.body.data.map((s: { key: string }) => s.key)).not.toContain(BAR);

      await save(BAR, { data: { items: [{ text: 'Hello' }] }, isPublished: true }).expect(200);
      await read(BAR).expect(200);
    });
  });

  // -------------------------------------------------------- banner slider

  describe('the homepage banner slider', () => {
    it('accepts up to five images', async () => {
      const items = Array.from({ length: 5 }, (_, i) => ({ url: image(i), alt: `Banner ${i}` }));
      const saved = await save(SLIDER, { data: { items } }).expect(200);
      expect(saved.body.data.data.items).toHaveLength(5);
    });

    it('refuses a sixth', async () => {
      const items = Array.from({ length: 6 }, (_, i) => ({ url: image(i) }));
      const rejected = await save(SLIDER, { data: { items } }).expect(400);
      expect(JSON.stringify(rejected.body)).toMatch(/at most 5 images/i);

      // And nothing was written — a rejected save must not half-apply.
      expect(await sectionModel.countDocuments({ key: SLIDER })).toBe(0);
    });

    it('holds images and nothing else', async () => {
      // Specified as images only: no heading, caption, or call to action.
      await save(SLIDER, {
        data: { items: [{ url: image(1), heading: 'Eid Sale' }] },
      }).expect(400);
    });

    it('keeps the order the images were given in', async () => {
      const items = [3, 1, 2].map((n) => ({ url: image(n) }));
      await save(SLIDER, { data: { items } }).expect(200);

      const slider = await read(SLIDER).expect(200);
      expect(slider.body.data.data.items.map((i: { url: string }) => i.url)).toEqual(
        items.map((i) => i.url),
      );
    });

    it('hides a slide switched off', async () => {
      await save(SLIDER, {
        data: {
          items: [{ url: image(1) }, { url: image(2), isActive: false }, { url: image(3) }],
        },
      }).expect(200);

      const shopper = await read(SLIDER).expect(200);
      expect(shopper.body.data.data.items.map((i: { url: string }) => i.url)).toEqual([
        image(1),
        image(3),
      ]);
    });
  });

  // -------------------------------------------------------- authorization

  describe('authorization', () => {
    it('lets anyone read', async () => {
      await request(app.getHttpServer()).get(api('/content/sections')).expect(200);
      await read(BAR).expect(200);
    });

    it('requires an admin to write', async () => {
      await request(app.getHttpServer())
        .put(api(`/content/sections/${BAR}`))
        .send({ data: { items: [] } })
        .expect(401);

      await save(BAR, { data: { items: [] } }, shopperToken).expect(403);
    });

    it('does not leak an unpublished section to a signed-in shopper', async () => {
      // Staff-only visibility is by role, not merely by holding a token.
      await save(BAR, { data: { items: [{ text: 'Hi' }] }, isPublished: false }).expect(200);
      await read(BAR, shopperToken).expect(404);
    });
  });
});
