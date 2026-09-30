import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import request from 'supertest';
import { Category, CategoryDocument } from '../src/modules/categories/schemas/category.schema';
import { Product, ProductDocument } from '../src/modules/products/schemas/product.schema';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/users/schemas/user.schema';
import { TestContext, api, createSuit, createTestApp } from './setup-app';

/**
 * The category tree: two levels, ordered for display, and the split placement a
 * product carries because of it.
 *
 * The rules under test are a set, not a list — the depth bound exists so that a
 * placement is always expressible as (parent, subcategory), and the placement
 * validation exists so no product can name a branch the tree does not have.
 * Breaking either one alone is what would leave the storefront rendering a menu
 * entry that resolves to nothing.
 */
describe('Category tree (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let productModel: Model<ProductDocument>;
  let categoryModel: Model<CategoryDocument>;
  let userModel: Model<UserDocument>;

  const password = 'StrongP@ssw0rd!';
  let adminToken: string;
  let shopperToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
    categoryModel = app.get<Model<CategoryDocument>>(getModelToken(Category.name));
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
    await Promise.all([
      productModel.deleteMany({}),
      categoryModel.deleteMany({}),
      userModel.deleteMany({}),
    ]);

    adminToken = await makeUser('admin@example.com', UserRole.ADMIN);
    shopperToken = await makeUser('shopper@example.com', UserRole.USER);
  });

  // --------------------------------------------------------------- helpers

  const postCategory = (body: Record<string, unknown>, token = adminToken) =>
    request(app.getHttpServer())
      .post(api('/categories'))
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const patchCategory = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(api(`/categories/${id}`))
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  const makeCategory = async (body: Record<string, unknown>): Promise<string> => {
    const created = await postCategory(body).expect(201);
    return created.body.data.id as string;
  };

  /**
   * A product in one colour, sold unstitched, filed wherever `body` says.
   *
   * Returns just `expect`, like the supertest request it wraps: the colour's
   * suit has to exist before the request is sent.
   */
  const postProduct = (body: Record<string, unknown>) => ({
    expect: async (status: number) =>
      request(app.getHttpServer())
        .post(api('/products'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Wireless Mouse',
          offers: [{ sizing: 'UNSTITCHED', price: 2499 }],
          variants: [{ erpId: await createSuit(app, 10), color: 'Red', hex: '#b22222' }],
          ...body,
        })
        .expect(status),
  });

  const makeProduct = async (body: Record<string, unknown>): Promise<string> => {
    const created = await postProduct(body).expect(201);
    return created.body.data.id as string;
  };

  // ------------------------------------------------------------- structure

  describe('a parent category has many subcategories', () => {
    it('nests subcategories under a top-level parent', async () => {
      const parent = await makeCategory({ name: 'Electronics' });
      const phones = await postCategory({ name: 'Phones', parentId: parent }).expect(201);
      const laptops = await postCategory({ name: 'Laptops', parentId: parent }).expect(201);

      expect(phones.body.data.parentId).toBe(parent);
      expect(laptops.body.data.parentId).toBe(parent);

      const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(tree.body.data).toHaveLength(1);
      expect(tree.body.data[0].id).toBe(parent);
      // Creation order. Subcategories append to the end of their branch, so
      // Phones (created first) leads — they no longer all share order 0 and fall
      // back to the alphabetical tiebreak.
      expect(tree.body.data[0].children.map((c: { name: string }) => c.name)).toEqual([
        'Phones',
        'Laptops',
      ]);
    });

    it('refuses a third level', async () => {
      // The bound is what makes a placement expressible as (parent, subcategory);
      // without it a product in a grandchild has no parent slot to occupy.
      const parent = await makeCategory({ name: 'Electronics' });
      const phones = await makeCategory({ name: 'Phones', parentId: parent });

      const nested = await postCategory({ name: 'Android', parentId: phones }).expect(409);
      expect(nested.body.message).toMatch(/two levels deep/i);
    });

    it('refuses to nest a category that already has subcategories', async () => {
      // The mirror of the rule above: demoting Electronics would push Phones to
      // a third level.
      const outer = await makeCategory({ name: 'Everything' });
      const parent = await makeCategory({ name: 'Electronics' });
      await makeCategory({ name: 'Phones', parentId: parent });

      const moved = await patchCategory(parent, { parentId: outer }).expect(409);
      expect(moved.body.message).toMatch(/subcategories of its own/i);
    });

    it('refuses to make a category its own parent', async () => {
      const parent = await makeCategory({ name: 'Electronics' });
      await patchCategory(parent, { parentId: parent }).expect(409);
    });

    it('refuses to delete a parent that still has subcategories', async () => {
      const parent = await makeCategory({ name: 'Electronics' });
      await makeCategory({ name: 'Phones', parentId: parent });

      await request(app.getHttpServer())
        .delete(api(`/categories/${parent}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
    });

    it('hides a whole branch when its parent is switched off', async () => {
      // Deactivating the parent is enough — no cascade onto the children, so
      // switching it back on restores exactly what was there before.
      const parent = await makeCategory({ name: 'Electronics' });
      await makeCategory({ name: 'Phones', parentId: parent });
      await patchCategory(parent, { isActive: false }).expect(200);

      const hidden = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(hidden.body.data).toHaveLength(0);

      await patchCategory(parent, { isActive: true }).expect(200);
      const restored = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(restored.body.data[0].children).toHaveLength(1);
    });

    it('never promotes an orphaned subcategory to the top level', async () => {
      // A hidden parent must not leak its children into the root menu.
      const parent = await makeCategory({ name: 'Electronics' });
      await makeCategory({ name: 'Phones', parentId: parent });
      await patchCategory(parent, { isActive: false }).expect(200);

      const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(tree.body.data.map((c: { name: string }) => c.name)).not.toContain('Phones');
    });

    it('shows an inactive branch to staff who ask, and never to a shopper', async () => {
      const parent = await makeCategory({ name: 'Electronics', isActive: false });
      await makeCategory({ name: 'Phones', parentId: parent, isActive: false });

      const staff = await request(app.getHttpServer())
        .get(api('/categories/tree?includeInactive=true'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(staff.body.data[0].children).toHaveLength(1);

      const shopper = await request(app.getHttpServer())
        .get(api('/categories/tree?includeInactive=true'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(shopper.body.data).toHaveLength(0);

      const anonymous = await request(app.getHttpServer())
        .get(api('/categories/tree?includeInactive=true'))
        .expect(200);
      expect(anonymous.body.data).toHaveLength(0);
    });

    it('keeps category writes to admins', async () => {
      await postCategory({ name: 'Electronics' }, shopperToken).expect(403);
    });
  });

  // ----------------------------------------------------------------- order

  describe('drag-to-reorder', () => {
    const reorder = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(api('/categories/reorder'))
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);

    const rootNames = async () => {
      const res = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      return (res.body.data as { name: string }[]).map((c) => c.name);
    };

    it('assigns dense positions from the dragged order', async () => {
      const a = await makeCategory({ name: 'Alpha' });
      const b = await makeCategory({ name: 'Bravo' });
      const c = await makeCategory({ name: 'Charlie' });

      const res = await reorder({ orderedIds: [c, a, b] }).expect(200);

      // 0..n-1, not the numbers that happened to be there before.
      expect(res.body.data.map((x: { name: string; order: number }) => [x.name, x.order])).toEqual([
        ['Charlie', 0],
        ['Alpha', 1],
        ['Bravo', 2],
      ]);
      expect(await rootNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    });

    it('reorders a subcategory branch without touching the root', async () => {
      const parent = await makeCategory({ name: 'Womenswear' });
      const other = await makeCategory({ name: 'Menswear' });
      const lawn = await makeCategory({ name: 'Lawn', parentId: parent });
      const silk = await makeCategory({ name: 'Silk', parentId: parent });

      await reorder({ parentId: parent, orderedIds: [silk, lawn] }).expect(200);

      const res = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      const branch = res.body.data.find((c: { id: string }) => c.id === parent);

      expect(branch.children.map((c: { name: string }) => c.name)).toEqual(['Silk', 'Lawn']);
      // The root order is untouched by a child reorder.
      expect(await rootNames()).toEqual(['Womenswear', 'Menswear']);
      expect(other).toBeDefined();
    });

    it('refuses a list that is missing a sibling', async () => {
      const a = await makeCategory({ name: 'Alpha' });
      await makeCategory({ name: 'Bravo' });

      // A short list means the client's view is stale; honouring it would move
      // categories nobody dragged.
      await reorder({ orderedIds: [a] }).expect(400);
    });

    it('refuses an id belonging to another parent', async () => {
      const parent = await makeCategory({ name: 'Womenswear' });
      const child = await makeCategory({ name: 'Lawn', parentId: parent });

      await reorder({ orderedIds: [parent, child] }).expect(400);
    });

    it('refuses duplicates', async () => {
      const a = await makeCategory({ name: 'Alpha' });
      await makeCategory({ name: 'Bravo' });

      await reorder({ orderedIds: [a, a] }).expect(400);
    });

    it('is idempotent', async () => {
      const a = await makeCategory({ name: 'Alpha' });
      const b = await makeCategory({ name: 'Bravo' });

      await reorder({ orderedIds: [b, a] }).expect(200);
      await reorder({ orderedIds: [b, a] }).expect(200);

      expect(await rootNames()).toEqual(['Bravo', 'Alpha']);
    });

    it('keeps admins only', async () => {
      const a = await makeCategory({ name: 'Alpha' });

      await request(app.getHttpServer())
        .post(api('/categories/reorder'))
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ orderedIds: [a] })
        .expect(403);
    });

    it('shows the new order to shoppers immediately', async () => {
      const a = await makeCategory({ name: 'Alpha' });
      const b = await makeCategory({ name: 'Bravo' });

      // Warm the shopper-facing cache, then reorder behind it.
      expect(await rootNames()).toEqual(['Alpha', 'Bravo']);
      await reorder({ orderedIds: [b, a] }).expect(200);

      expect(await rootNames()).toEqual(['Bravo', 'Alpha']);
    });
  });

  describe('new categories append to the end of their branch', () => {
    it('gives each new sibling the next position rather than all sharing zero', async () => {
      await makeCategory({ name: 'Zulu' });
      await makeCategory({ name: 'Alpha' });
      await makeCategory({ name: 'Mike' });

      const res = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      const orders = (res.body.data as { name: string; order: number }[]).map((c) => [
        c.name,
        c.order,
      ]);

      // Creation order, not alphabetical: every category used to default to 0,
      // which left the list tied and falling back to the name tiebreak.
      expect(orders).toEqual([
        ['Zulu', 0],
        ['Alpha', 1],
        ['Mike', 2],
      ]);
    });

    it('numbers a subcategory branch independently of the root', async () => {
      const parent = await makeCategory({ name: 'Womenswear' });
      const first = await makeCategory({ name: 'Lawn', parentId: parent });
      const second = await makeCategory({ name: 'Silk', parentId: parent });

      const res = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      const byId = new Map(
        (res.body.data as { id: string; order: number }[]).map((c) => [c.id, c.order]),
      );

      expect(byId.get(parent)).toBe(0);
      expect(byId.get(first)).toBe(0);
      expect(byId.get(second)).toBe(1);
    });
  });

  describe('the tree is cached, and a write retires it', () => {
    /**
     * Each of these reads the tree first, so a cached copy exists, then writes,
     * then reads again. Without invalidation the second read returns the first
     * answer — which is the whole failure mode a cache introduces.
     */
    const tree = (token?: string, includeInactive = false) => {
      const req = request(app.getHttpServer()).get(
        api(`/categories/tree${includeInactive ? '?includeInactive=true' : ''}`),
      );
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    const names = (body: { data: { name: string }[] }) => body.data.map((c) => c.name);

    it('serves the same tree twice', async () => {
      await makeCategory({ name: 'Lawn' });

      const first = await tree().expect(200);
      const second = await tree().expect(200);

      expect(names(second.body)).toEqual(names(first.body));
    });

    it('shows a category created after the tree was cached', async () => {
      await makeCategory({ name: 'Lawn' });
      await tree().expect(200);

      await makeCategory({ name: 'Chiffon' });

      const after = await tree().expect(200);
      expect(names(after.body)).toEqual(expect.arrayContaining(['Lawn', 'Chiffon']));
    });

    it('shows a rename after the tree was cached', async () => {
      const id = await makeCategory({ name: 'Lawn' });
      await tree().expect(200);

      await patchCategory(id, { name: 'Lawn Collection' }).expect(200);

      expect(names((await tree().expect(200)).body)).toContain('Lawn Collection');
    });

    it('drops a deleted category from the cached tree', async () => {
      const id = await makeCategory({ name: 'Lawn' });
      await tree().expect(200);

      await request(app.getHttpServer())
        .delete(api(`/categories/${id}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(names((await tree().expect(200)).body)).not.toContain('Lawn');
    });

    it('reflects a reorder in the cached tree', async () => {
      const first = await makeCategory({ name: 'Alpha', order: 1 });
      await makeCategory({ name: 'Beta', order: 2 });
      expect(names((await tree().expect(200)).body)).toEqual(['Alpha', 'Beta']);

      await patchCategory(first, { order: 3 }).expect(200);

      expect(names((await tree().expect(200)).body)).toEqual(['Beta', 'Alpha']);
    });

    it('never leaks a staff tree into a shopper cache', async () => {
      await makeCategory({ name: 'Live' });
      const hidden = await makeCategory({ name: 'Hidden', isActive: false });

      // Staff read first, so the inactive branch is the one in the cache.
      const staff = await tree(adminToken, true).expect(200);
      expect(names(staff.body)).toEqual(expect.arrayContaining(['Live', 'Hidden']));

      // The shopper must get their own key, not the staff one.
      expect(names((await tree().expect(200)).body)).toEqual(['Live']);
      expect(hidden).toBeDefined();
    });

    it('reflects a deactivation in the shopper tree', async () => {
      const id = await makeCategory({ name: 'Lawn' });
      expect(names((await tree().expect(200)).body)).toContain('Lawn');

      await patchCategory(id, { isActive: false }).expect(200);

      expect(names((await tree().expect(200)).body)).not.toContain('Lawn');
    });

    it('retires the flat listing as well as the tree', async () => {
      await makeCategory({ name: 'Lawn' });
      const before = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      expect(before.body.data).toHaveLength(1);

      await makeCategory({ name: 'Chiffon' });

      const after = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      expect(after.body.data).toHaveLength(2);
    });

    it('reflects a re-parent, which writes inside a transaction', async () => {
      const parent = await makeCategory({ name: 'Womenswear' });
      const other = await makeCategory({ name: 'Menswear' });
      const child = await makeCategory({ name: 'Lawn', parentId: parent });

      const before = await tree().expect(200);
      expect(before.body.data.find((c: { id: string }) => c.id === parent).children).toHaveLength(
        1,
      );

      await patchCategory(child, { parentId: other }).expect(200);

      const after = await tree().expect(200);
      const byId = (id: string) => after.body.data.find((c: { id: string }) => c.id === id);
      expect(byId(parent).children).toHaveLength(0);
      expect(byId(other).children).toHaveLength(1);
    });
  });

  describe('display order', () => {
    it('sorts siblings by order, then by name', async () => {
      await makeCategory({ name: 'Clothing', order: 2 });
      await makeCategory({ name: 'Electronics', order: 1 });
      await makeCategory({ name: 'Books', order: 1 });

      const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(tree.body.data.map((c: { name: string }) => c.name)).toEqual([
        'Books',
        'Electronics',
        'Clothing',
      ]);
    });

    it('keeps creation order when nothing sets an order', async () => {
      // Superseded contract: categories used to default to 0 and fall back to
      // the alphabetical tiebreak, which meant a merchant who had never touched
      // `order` saw a list they could not rearrange and could not explain. New
      // ones now append to the end of their branch instead.
      await makeCategory({ name: 'Clothing' });
      await makeCategory({ name: 'Books' });
      await makeCategory({ name: 'Electronics' });

      const listed = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      expect(listed.body.data.map((c: { name: string }) => c.name)).toEqual([
        'Clothing',
        'Books',
        'Electronics',
      ]);
      expect(listed.body.data.map((c: { order: number }) => c.order)).toEqual([0, 1, 2]);
    });

    it('still breaks a genuine tie by name', async () => {
      // Ties are only reachable by setting `order` explicitly now, but the
      // tiebreak still has to be deterministic.
      await makeCategory({ name: 'Clothing', order: 5 });
      await makeCategory({ name: 'Books', order: 5 });

      const listed = await request(app.getHttpServer()).get(api('/categories')).expect(200);
      expect(listed.body.data.map((c: { name: string }) => c.name)).toEqual(['Books', 'Clothing']);
    });

    it('orders subcategories within their own parent', async () => {
      const electronics = await makeCategory({ name: 'Electronics', order: 0 });
      const clothing = await makeCategory({ name: 'Clothing', order: 1 });
      await makeCategory({ name: 'Phones', parentId: electronics, order: 5 });
      await makeCategory({ name: 'Laptops', parentId: electronics, order: 1 });
      await makeCategory({ name: 'Shoes', parentId: clothing, order: 9 });
      await makeCategory({ name: 'Hats', parentId: clothing, order: 2 });

      const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      // A high `order` on a subcategory is scoped to its siblings; it does not
      // sort against subcategories of a different parent.
      expect(
        tree.body.data.map((c: { name: string; children: { name: string }[] }) => [
          c.name,
          c.children.map((child) => child.name),
        ]),
      ).toEqual([
        ['Electronics', ['Laptops', 'Phones']],
        ['Clothing', ['Hats', 'Shoes']],
      ]);
    });

    it('reorders through a patch', async () => {
      const books = await makeCategory({ name: 'Books', order: 0 });
      await makeCategory({ name: 'Clothing', order: 1 });

      await patchCategory(books, { order: 5 }).expect(200);

      const tree = await request(app.getHttpServer()).get(api('/categories/tree')).expect(200);
      expect(tree.body.data.map((c: { name: string }) => c.name)).toEqual(['Clothing', 'Books']);
    });

    it('rejects a negative or non-integer order', async () => {
      await postCategory({ name: 'Books', order: -1 }).expect(400);
      await postCategory({ name: 'Books', order: 1.5 }).expect(400);
    });
  });

  // ------------------------------------------------------------- placement

  describe('a product sits in one parent and at most one subcategory', () => {
    let electronics: string;
    let phones: string;
    let clothing: string;
    let shoes: string;

    beforeEach(async () => {
      electronics = await makeCategory({ name: 'Electronics' });
      phones = await makeCategory({ name: 'Phones', parentId: electronics });
      clothing = await makeCategory({ name: 'Clothing' });
      shoes = await makeCategory({ name: 'Shoes', parentId: clothing });
    });

    it('accepts a parent on its own', async () => {
      const created = await postProduct({ categoryId: electronics }).expect(201);
      expect(created.body.data.categoryId).toBe(electronics);
      expect(created.body.data.subcategoryId).toBeNull();
    });

    it('accepts a parent with one of its subcategories', async () => {
      const created = await postProduct({
        categoryId: electronics,
        subcategoryId: phones,
      }).expect(201);

      expect(created.body.data.categoryId).toBe(electronics);
      expect(created.body.data.subcategoryId).toBe(phones);

      const stored = await productModel.findById(created.body.data.id).exec();
      expect(stored?.categoryId.toString()).toBe(electronics);
      expect(stored?.subcategoryId?.toString()).toBe(phones);
    });

    it('refuses a product with no category at all', async () => {
      // Required, not merely validated when present: an unfiled product is one
      // no storefront filter reaches and no ERP row maps to.
      await postProduct({}).expect(400);
    });

    it('rejects a subcategory without its parent', async () => {
      // On create the DTO stops it, `categoryId` being required. On update the
      // domain check is what catches it, since a patch need not carry both.
      await postProduct({ subcategoryId: phones }).expect(400);

      const product = await makeProduct({ categoryId: electronics });
      const rejected = await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId: null, subcategoryId: phones })
        .expect(400);
      expect(rejected.body.message).toMatch(/accompanied by its parent/i);
    });

    it('rejects a subcategory belonging to a different parent', async () => {
      // The pair has to describe a branch that exists, not two ids that each do.
      const rejected = await postProduct({
        categoryId: electronics,
        subcategoryId: shoes,
      }).expect(400);
      expect(rejected.body.message).toMatch(/not a subcategory of/i);
    });

    it('rejects a subcategory passed where the parent belongs', async () => {
      const rejected = await postProduct({ categoryId: phones }).expect(400);
      expect(rejected.body.message).toMatch(/pass it as subcategoryId/i);
    });

    it('rejects an unknown category', async () => {
      await postProduct({ categoryId: '0123456789abcdef01234567' }).expect(404);
      await postProduct({
        categoryId: electronics,
        subcategoryId: '0123456789abcdef01234567',
      }).expect(404);
    });

    it('refuses to move a product to a parent that orphans its subcategory', async () => {
      // Silently clearing `subcategoryId` here would drop a placement the caller
      // never asked to lose, so the contradiction is reported instead.
      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      const rejected = await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId: clothing })
        .expect(400);
      expect(rejected.body.message).toMatch(/not a subcategory of/i);

      const unchanged = await productModel.findById(product).exec();
      expect(unchanged?.categoryId.toString()).toBe(electronics);
      expect(unchanged?.subcategoryId?.toString()).toBe(phones);
    });

    it('moves a product between branches when both halves are sent together', async () => {
      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      const moved = await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId: clothing, subcategoryId: shoes })
        .expect(200);

      expect(moved.body.data.categoryId).toBe(clothing);
      expect(moved.body.data.subcategoryId).toBe(shoes);
    });

    it('drops just the subcategory, keeping the parent', async () => {
      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      const patched = await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ subcategoryId: null })
        .expect(200);

      expect(patched.body.data.categoryId).toBe(electronics);
      expect(patched.body.data.subcategoryId).toBeNull();
    });

    it('refuses to clear the parent while a subcategory remains', async () => {
      // Rejected either way: the category is required, and the subcategory would
      // be orphaned.

      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId: null })
        .expect(400);
    });

    it('refuses to clear the category on an existing product', async () => {
      // `categoryId` is required on create; an update must not be a back door
      // around that.
      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      const rejected = await request(app.getHttpServer())
        .patch(api(`/products/${product}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ categoryId: null, subcategoryId: null })
        .expect(400);
      expect(rejected.body.message).toMatch(/must belong to a category/i);

      const unchanged = await productModel.findById(product).exec();
      expect(unchanged?.categoryId.toString()).toBe(electronics);
    });
  });

  // ------------------------------------------------------------- filtering

  describe('filtering by branch', () => {
    let electronics: string;
    let phones: string;
    let laptops: string;

    beforeEach(async () => {
      electronics = await makeCategory({ name: 'Electronics' });
      phones = await makeCategory({ name: 'Phones', parentId: electronics });
      laptops = await makeCategory({ name: 'Laptops', parentId: electronics });

      const other = await makeCategory({ name: 'Clothing' });
      await makeProduct({ name: 'Bare', categoryId: electronics });
      await makeProduct({ name: 'Pixel', categoryId: electronics, subcategoryId: phones });
      await makeProduct({ name: 'ThinkPad', categoryId: electronics, subcategoryId: laptops });
      // In a different branch, so the filters below have something to exclude.
      await makeProduct({ name: 'Scarf', categoryId: other });
    });

    it('returns the whole branch when filtering by the parent', async () => {
      // The reason the parent id is denormalised onto every product: this stays
      // one indexed equality match rather than a lookup of the branch first.
      const listed = await request(app.getHttpServer())
        .get(api(`/products?categoryId=${electronics}`))
        .expect(200);

      expect(listed.body.data.meta.total).toBe(3);
      expect(listed.body.data.items.map((p: { name: string }) => p.name).sort()).toEqual([
        'Bare',
        'Pixel',
        'ThinkPad',
      ]);
    });

    it('narrows to a single subcategory', async () => {
      const listed = await request(app.getHttpServer())
        .get(api(`/products?subcategoryId=${phones}`))
        .expect(200);

      expect(listed.body.data.meta.total).toBe(1);
      expect(listed.body.data.items[0].name).toBe('Pixel');
    });

    it('combines both halves', async () => {
      const listed = await request(app.getHttpServer())
        .get(api(`/products?categoryId=${electronics}&subcategoryId=${laptops}`))
        .expect(200);

      expect(listed.body.data.meta.total).toBe(1);
      expect(listed.body.data.items[0].name).toBe('ThinkPad');
    });

    it('rejects a malformed subcategory filter rather than ignoring it', async () => {
      await request(app.getHttpServer()).get(api('/products?subcategoryId=nonsense')).expect(400);
    });
  });

  // ----------------------------------------------------------------- moves

  describe('moving a category takes its products with it', () => {
    it('re-points products when a top-level category is nested', async () => {
      // The product has not changed shelf — the shelf moved. Leaving categoryId
      // pointing at a category that is no longer top-level would be a placement
      // the API itself would refuse to create.
      const electronics = await makeCategory({ name: 'Electronics' });
      const audio = await makeCategory({ name: 'Audio' });
      const product = await makeProduct({ categoryId: audio });

      await patchCategory(audio, { parentId: electronics }).expect(200);

      const moved = await productModel.findById(product).exec();
      expect(moved?.categoryId.toString()).toBe(electronics);
      expect(moved?.subcategoryId?.toString()).toBe(audio);

      // And the storefront finds it under the new parent.
      const listed = await request(app.getHttpServer())
        .get(api(`/products?categoryId=${electronics}`))
        .expect(200);
      expect(listed.body.data.meta.total).toBe(1);
    });

    it('re-points products when a subcategory is promoted to the top level', async () => {
      const electronics = await makeCategory({ name: 'Electronics' });
      const phones = await makeCategory({ name: 'Phones', parentId: electronics });
      const product = await makeProduct({ categoryId: electronics, subcategoryId: phones });

      await patchCategory(phones, { parentId: null }).expect(200);

      const moved = await productModel.findById(product).exec();
      expect(moved?.categoryId.toString()).toBe(phones);
      expect(moved?.subcategoryId).toBeNull();
    });

    it('re-parents a subcategory and carries its products to the new parent', async () => {
      const electronics = await makeCategory({ name: 'Electronics' });
      const office = await makeCategory({ name: 'Office' });
      const printers = await makeCategory({ name: 'Printers', parentId: electronics });
      const product = await makeProduct({ categoryId: electronics, subcategoryId: printers });

      await patchCategory(printers, { parentId: office }).expect(200);

      const moved = await productModel.findById(product).exec();
      expect(moved?.categoryId.toString()).toBe(office);
      expect(moved?.subcategoryId?.toString()).toBe(printers);
    });

    it('leaves every placement valid after a move', async () => {
      // The invariant behind all three cases above: whatever a product ends up
      // pointing at, the API would accept that same pair on a fresh create.
      const electronics = await makeCategory({ name: 'Electronics' });
      const audio = await makeCategory({ name: 'Audio' });
      await makeProduct({ categoryId: audio });

      await patchCategory(audio, { parentId: electronics }).expect(200);

      const product = await productModel.findOne({}).exec();
      await postProduct({
        name: 'Replica',
        categoryId: product!.categoryId.toString(),
        subcategoryId: product!.subcategoryId!.toString(),
      }).expect(201);
    });

    it('refuses to delete a subcategory that still holds products', async () => {
      const electronics = await makeCategory({ name: 'Electronics' });
      const phones = await makeCategory({ name: 'Phones', parentId: electronics });
      await makeProduct({ categoryId: electronics, subcategoryId: phones });

      const refused = await request(app.getHttpServer())
        .delete(api(`/categories/${phones}`))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(refused.body.message).toMatch(/1 product/);
    });

    it('serves a fresh product after a move, not just a fresh listing', async () => {
      // The list cache is retired by a version bump, which is cheap and covers
      // every page at once. Individual product entries are keyed by id, so they
      // have to be dropped by id — and a re-parent rewrites exactly the two
      // fields those entries carry.
      const electronics = await makeCategory({ name: 'Electronics' });
      const audio = await makeCategory({ name: 'Audio' });
      const product = await makeProduct({ categoryId: audio });

      // Warm the single-product entry on the pre-move placement.
      const before = await request(app.getHttpServer())
        .get(api(`/products/${product}`))
        .expect(200);
      expect(before.body.data.categoryId).toBe(audio);

      await patchCategory(audio, { parentId: electronics }).expect(200);

      const after = await request(app.getHttpServer())
        .get(api(`/products/${product}`))
        .expect(200);
      expect(after.body.data.categoryId).toBe(electronics);
      expect(after.body.data.subcategoryId).toBe(audio);
    });

    it('serves a fresh listing after a move rather than a cached one', async () => {
      const electronics = await makeCategory({ name: 'Electronics' });
      const audio = await makeCategory({ name: 'Audio' });
      await makeProduct({ categoryId: audio });

      // Warm the cache on the pre-move state.
      const before = await request(app.getHttpServer())
        .get(api(`/products?categoryId=${electronics}`))
        .expect(200);
      expect(before.body.data.meta.total).toBe(0);

      await patchCategory(audio, { parentId: electronics }).expect(200);

      const after = await request(app.getHttpServer())
        .get(api(`/products?categoryId=${electronics}`))
        .expect(200);
      expect(after.body.data.meta.total).toBe(1);
    });
  });
});
