import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, FilterQuery, Model, Types } from 'mongoose';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { EVENTS, ProductsChangedEvent } from '../../events/domain-events';
import {
  CategoryResponseDto,
  CategoryTreeDto,
  CreateCategoryDto,
  ReorderCategoriesDto,
  UpdateCategoryDto,
} from './dto/category.dto';
import { CategoryCacheService } from './category-cache.service';
import { Category, CategoryDocument } from './schemas/category.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';

/** Where a product sits in the tree, resolved and validated. */
export interface CategoryPlacement {
  categoryId: Types.ObjectId;
  subcategoryId: Types.ObjectId | null;
}

/**
 * The category tree, two levels deep.
 *
 * A top-level category holds many subcategories; a subcategory holds none. That
 * bound is enforced here rather than left to convention, because the product
 * side stores a placement as an explicit (parent, subcategory) pair — a third
 * level would have nowhere to live, and would quietly disappear from every
 * product that referenced it.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CategoryCacheService,
  ) {}

  // ------------------------------------------------------------------- reads

  /**
   * Flat listing in display order.
   *
   * `order` first, `name` as the tiebreaker — so a catalogue that never sets
   * `order` keeps the alphabetical listing it had before the field existed.
   */
  async list(includeInactive = false): Promise<CategoryResponseDto[]> {
    const cached = await this.cache.lookup<CategoryResponseDto[]>('list', includeInactive);
    if (cached.value) return cached.value;

    const categories = await this.categoryModel
      .find(this.visibilityFilter(includeInactive))
      .sort({ order: 1, name: 1 })
      .exec();

    const response = categories.map(CategoryResponseDto.from);
    await cached.save(response);
    return response;
  }

  /**
   * The same categories, nested — top-level entries each carrying their
   * subcategories, both levels already sorted.
   *
   * A subcategory whose parent is excluded from this view is dropped rather than
   * promoted to the top level: an inactive parent hides its whole branch, which
   * is what an administrator switching a section off expects, and it needs no
   * cascade onto the children to achieve.
   */
  async tree(includeInactive = false): Promise<CategoryTreeDto[]> {
    // The storefront's most-requested read: every page renders the nav from it.
    const cached = await this.cache.lookup<CategoryTreeDto[]>('tree', includeInactive);
    if (cached.value) return cached.value;

    const categories = await this.categoryModel
      .find(this.visibilityFilter(includeInactive))
      .sort({ order: 1, name: 1 })
      .exec();

    const roots = categories.filter((category) => category.parentId === null);
    const childrenByParent = new Map<string, CategoryResponseDto[]>();

    for (const category of categories) {
      if (!category.parentId) continue;
      const parentId = category.parentId.toString();
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(CategoryResponseDto.from(category));
      else childrenByParent.set(parentId, [CategoryResponseDto.from(category)]);
    }

    const response = roots.map((root) => ({
      ...CategoryResponseDto.from(root),
      children: childrenByParent.get(root._id.toString()) ?? [],
    }));

    await cached.save(response);
    return response;
  }

  async findById(id: string): Promise<CategoryResponseDto> {
    return CategoryResponseDto.from(await this.getDocumentOrThrow(id));
  }

  // ------------------------------------------------------------------ writes

  async create(dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    const slug = await this.uniqueSlug(dto.slug ?? dto.name);
    if (dto.parentId) await this.assertCanParent(dto.parentId);

    const parentId = dto.parentId ? new Types.ObjectId(dto.parentId) : null;

    const category = await this.categoryModel.create({
      name: dto.name,
      slug,
      description: dto.description ?? null,
      parentId,
      // Appended, not 0. Defaulting every new category to the same position left
      // the whole list tied and falling back to the alphabetical tiebreak, so a
      // merchant who had never touched `order` saw an order they could not
      // explain — and drag-to-reorder needs dense, distinct positions anyway.
      order: dto.order ?? (await this.nextOrder(parentId)),
      isActive: dto.isActive ?? true,
    });

    await this.cache.invalidate();
    return CategoryResponseDto.from(category);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryResponseDto> {
    const category = await this.getDocumentOrThrow(id);

    if (dto.name !== undefined) category.name = dto.name;
    if (dto.slug !== undefined) category.slug = await this.uniqueSlug(dto.slug, category._id);
    if (dto.description !== undefined) category.description = dto.description;
    if (dto.order !== undefined) category.order = dto.order;
    if (dto.isActive !== undefined) category.isActive = dto.isActive;

    const nextParentId = await this.resolveNextParent(category, dto);
    const reparenting = nextParentId !== undefined;

    if (!reparenting) {
      await category.save();
      await this.cache.invalidate();
      return CategoryResponseDto.from(category);
    }

    const previousParentId = category.parentId;
    category.parentId = nextParentId;

    // The move and the product re-pointing it forces are one change. Half of it
    // would leave products claiming a placement the tree no longer describes,
    // which is exactly what `assertPlacement` refuses to create in the first
    // place.
    const session = await this.connection.startSession();
    let moved: Types.ObjectId[] = [];
    try {
      await session.withTransaction(async () => {
        await category.save({ session });
        moved = await this.repointProducts(category._id, previousParentId, nextParentId, session);
      });
    } finally {
      await session.endSession();
    }

    // Both after the commit, so nothing can repopulate a cached view from the
    // pre-commit state. The tree is retired directly because this module owns
    // that cache; the products it moved are only announced, because that cache
    // belongs to the products module and this one has no business knowing
    // products are cached at all.
    await this.cache.invalidate();
    await this.announceProductChanges(moved);
    return CategoryResponseDto.from(category);
  }

  /**
   * Rewrite a branch's display order from a dragged list.
   *
   * Positions are assigned densely, 0..n-1, rather than preserving whatever
   * numbers were there: the merchant expressed an order, not arithmetic, and
   * dense positions are what make the next drag unambiguous.
   *
   * Transactional because a half-applied reorder is a menu in an order nobody
   * chose — and because the membership check and the writes must see the same
   * branch.
   */
  async reorder(dto: ReorderCategoriesDto): Promise<CategoryResponseDto[]> {
    const parentId = dto.parentId ? new Types.ObjectId(dto.parentId) : null;
    const ids = dto.orderedIds.map((id) => new Types.ObjectId(id));

    const unique = new Set(dto.orderedIds);
    if (unique.size !== dto.orderedIds.length) {
      throw new ValidationFailedException('orderedIds contains duplicates');
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Every id must actually be a child of this parent. Without this a
        // client could renumber someone else's branch, or silently drop a
        // sibling it had not loaded — either leaves the menu wrong.
        const siblings = await this.categoryModel
          .find({ parentId, ...notDeleted }, { _id: 1 })
          .session(session)
          .lean()
          .exec();

        const actual = new Set(siblings.map((c) => c._id.toString()));

        const foreign = dto.orderedIds.filter((id) => !actual.has(id));
        if (foreign.length > 0) {
          throw new ValidationFailedException('Every id must be a child of the given parent', {
            parentId: dto.parentId ?? null,
            foreign,
          });
        }

        // Partial lists are refused rather than appended to: an incomplete list
        // means the client's view of the branch is stale, and honouring it would
        // move categories the merchant never dragged.
        if (actual.size !== ids.length) {
          throw new ValidationFailedException('orderedIds must list every child of the parent', {
            expected: actual.size,
            received: ids.length,
          });
        }

        await this.categoryModel.bulkWrite(
          ids.map((id, index) => ({
            updateOne: { filter: { _id: id }, update: { $set: { order: index } } },
          })),
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    await this.cache.invalidate();

    // The reordered branch, so the client can settle on server truth rather than
    // trusting the optimistic order it just drew.
    return this.categoryModel
      .find({ parentId, ...notDeleted })
      .sort({ order: 1, name: 1 })
      .exec()
      .then((docs) => docs.map(CategoryResponseDto.from));
  }

  /** One past the last sibling, so a new category lands at the end. */
  private async nextOrder(parentId: Types.ObjectId | null): Promise<number> {
    const last = await this.categoryModel
      .findOne({ parentId, ...notDeleted })
      .sort({ order: -1 })
      .select('order')
      .lean()
      .exec();

    return last ? last.order + 1 : 0;
  }

  /**
   * Soft delete, refused while products still point here — orphaning a
   * product's category would leave the storefront filtering on a category that
   * no longer resolves.
   */
  async remove(id: string): Promise<void> {
    const category = await this.getDocumentOrThrow(id);

    // Either half of a placement counts: a category is in use whether products
    // sit in it directly or nest one level below it.
    const inUse = await this.productModel.countDocuments({
      $or: [{ categoryId: category._id }, { subcategoryId: category._id }],
      ...notDeleted,
    });
    if (inUse > 0) {
      throw new ConflictException(
        `Cannot delete a category with ${inUse} product(s); reassign them first`,
      );
    }

    const hasChildren = await this.categoryModel.exists({ parentId: category._id, ...notDeleted });
    if (hasChildren) throw new ConflictException('Cannot delete a category that has subcategories');

    category.deletedAt = new Date();
    category.isActive = false;
    category.slug = `${category.slug}-deleted-${Date.now()}`;
    await category.save();
    await this.cache.invalidate();
  }

  // -------------------------------------------------------------- placement

  /**
   * Validate a product's placement and return it as ObjectIds.
   *
   * The two shapes a product may take are (parent) and (parent, subcategory).
   * Everything else — no category at all, a subcategory on its own, a
   * subcategory belonging to some other parent, or a subcategory passed where a
   * parent belongs — is rejected here, so no product can reach the database
   * describing a branch that does not exist.
   */
  async assertPlacement(
    categoryId: string | null,
    subcategoryId: string | null,
  ): Promise<CategoryPlacement> {
    if (subcategoryId && !categoryId) {
      throw new ValidationFailedException(
        'A subcategory must be accompanied by its parent category',
        { subcategoryId },
      );
    }

    if (!categoryId) {
      // Reached from an update that clears the field; a create is stopped
      // earlier, by `categoryId` being required on the DTO.
      throw new ValidationFailedException('A product must belong to a category');
    }

    const parent = await this.getDocumentOrThrow(categoryId);
    if (parent.parentId) {
      throw new ValidationFailedException(
        `"${parent.name}" is a subcategory; pass it as subcategoryId alongside its parent category`,
        { categoryId, parentId: parent.parentId.toString() },
      );
    }

    if (!subcategoryId) return { categoryId: parent._id, subcategoryId: null };

    const child = await this.getDocumentOrThrow(subcategoryId);
    if (!child.parentId || !child.parentId.equals(parent._id)) {
      throw new ValidationFailedException(
        `"${child.name}" is not a subcategory of "${parent.name}"`,
        { categoryId, subcategoryId },
      );
    }

    return { categoryId: parent._id, subcategoryId: child._id };
  }

  // ------------------------------------------------------------------ shared

  /**
   * Tell the catalogue that a branch move rewrote these products.
   *
   * Awaited so the invalidation lands before the response is written — a client
   * that re-reads the product immediately afterwards must not race it. A
   * listener failure is logged by the listener and never propagated: the move
   * has committed, and a stale cache entry is not worth failing it over.
   */
  private async announceProductChanges(productIds: Types.ObjectId[]): Promise<void> {
    const event: ProductsChangedEvent = { productIds: productIds.map((id) => id.toString()) };
    await this.eventEmitter.emitAsync(EVENTS.PRODUCTS_CHANGED, event);
  }

  private visibilityFilter(includeInactive: boolean): FilterQuery<CategoryDocument> {
    return { ...notDeleted, ...(includeInactive ? {} : { isActive: true }) };
  }

  /**
   * The parent this update moves the category to, or `undefined` when the update
   * leaves it where it is. `null` is a real value here — it means "promote to
   * top level" — so absence has to be signalled separately.
   */
  private async resolveNextParent(
    category: CategoryDocument,
    dto: UpdateCategoryDto,
  ): Promise<Types.ObjectId | null | undefined> {
    if (dto.parentId === undefined) return undefined;

    const id = category._id.toString();
    if (dto.parentId === id) throw new ConflictException('A category cannot be its own parent');

    const current = category.parentId ? category.parentId.toString() : null;
    const next = dto.parentId || null;
    if (current === next) return undefined;

    if (next === null) return null;

    // Nesting this category would put anything beneath it on a third level.
    const hasChildren = await this.categoryModel.exists({ parentId: category._id, ...notDeleted });
    if (hasChildren) {
      throw new ConflictException(
        'Cannot nest a category that has subcategories of its own; the tree is two levels deep',
      );
    }

    await this.assertCanParent(next);
    return new Types.ObjectId(next);
  }

  /** A parent must exist and must itself be top-level. */
  private async assertCanParent(parentId: string): Promise<void> {
    const parent = await this.getDocumentOrThrow(parentId);
    if (parent.parentId) {
      throw new ConflictException(
        `"${parent.name}" is already a subcategory; the category tree is two levels deep`,
      );
    }
  }

  /**
   * Keep product placements consistent with a category that just moved.
   *
   * Both directions are a rewrite rather than a clear, because the product has
   * not changed shelf — the shelf has moved:
   *
   *  - nested under P: a product sitting directly in this category is now in
   *    `P > this`, and one already below it swaps its parent for P.
   *  - promoted to top level: a product that reached it through the old parent
   *    now sits in it directly.
   */
  private async repointProducts(
    categoryId: Types.ObjectId,
    previousParentId: Types.ObjectId | null,
    nextParentId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<Types.ObjectId[]> {
    // Collected before the writes, because afterwards nothing distinguishes a
    // product this move touched from one that was already there.
    const affected = await this.productModel
      .find({ $or: [{ categoryId }, { subcategoryId: categoryId }] }, { _id: 1 })
      .session(session)
      .lean()
      .exec();
    const movedIds = affected.map((product) => product._id);

    if (nextParentId) {
      // Order matters: re-point the products already below this category before
      // the direct ones, so the second filter cannot match rows the first moved.
      await this.productModel.updateMany(
        { subcategoryId: categoryId },
        { $set: { categoryId: nextParentId } },
        { session },
      );
      await this.productModel.updateMany(
        { categoryId, subcategoryId: null },
        { $set: { categoryId: nextParentId, subcategoryId: categoryId } },
        { session },
      );
      return movedIds;
    }

    // Promoted to top level. Only products that reached it as a subcategory of
    // its former parent need moving; a top-level category cannot have been the
    // subcategory half of any placement.
    if (previousParentId) {
      await this.productModel.updateMany(
        { subcategoryId: categoryId },
        { $set: { categoryId, subcategoryId: null } },
        { session },
      );
    }

    return movedIds;
  }

  private async getDocumentOrThrow(id: string): Promise<CategoryDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Category', id);
    const category = await this.categoryModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!category) throw new ResourceNotFoundException('Category', id);
    return category;
  }

  private async uniqueSlug(source: string, excludeId?: Types.ObjectId): Promise<string> {
    const base =
      source
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200) || 'category';

    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      const clash = await this.categoryModel.exists({
        slug: candidate,
        ...notDeleted,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      });
      if (!clash) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}
