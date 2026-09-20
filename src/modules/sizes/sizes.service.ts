import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTS } from '../../events/domain-events';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateSizeDto, SizeResponseDto, UpdateSizeDto } from './dto/size.dto';
import { Size, SizeDocument } from './schemas/size.schema';

/** A size resolved for storage on a product or an order line. */
export interface ResolvedSize {
  id: Types.ObjectId;
  name: string;
  code: string;
}

@Injectable()
export class SizesService {
  constructor(
    @InjectModel(Size.name) private readonly sizeModel: Model<SizeDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------- reads

  async list(includeInactive = false): Promise<SizeResponseDto[]> {
    const sizes = await this.sizeModel
      .find(this.visibilityFilter(includeInactive))
      // Sizes have no natural order; the merchant states it.
      .sort({ order: 1, code: 1 })
      .exec();
    return sizes.map(SizeResponseDto.from);
  }

  async findById(id: string): Promise<SizeResponseDto> {
    return SizeResponseDto.from(await this.getDocumentOrThrow(id));
  }

  // ------------------------------------------------------------------ writes

  async create(dto: CreateSizeDto): Promise<SizeResponseDto> {
    await this.assertCodeAvailable(dto.code);

    const size = await this.sizeModel.create({
      name: dto.name,
      code: dto.code,
      order: dto.order ?? 0,
      isActive: dto.isActive ?? true,
    });

    return SizeResponseDto.from(size);
  }

  async update(id: string, dto: UpdateSizeDto): Promise<SizeResponseDto> {
    const size = await this.getDocumentOrThrow(id);

    if (dto.code !== undefined && dto.code !== size.code) {
      await this.assertCodeAvailable(dto.code, size._id);
      size.code = dto.code;
    }
    if (dto.name !== undefined) size.name = dto.name;
    if (dto.order !== undefined) size.order = dto.order;
    if (dto.isActive !== undefined) size.isActive = dto.isActive;

    // Announce before returning, not after: a product's cached view embeds the
    // size's `name` and `code`, so renaming M from "Medium" to "Regular" used to
    // leave every product page showing the old name until its entry aged out a
    // day later. Categories already announce for the same reason; sizes were
    // missed because the module comment only reasoned about category *ids*.
    const touched = size.modifiedPaths().length > 0;
    await size.save();
    if (touched) await this.eventEmitter.emitAsync(EVENTS.PRODUCTS_CHANGED, { productIds: [] });

    return SizeResponseDto.from(size);
  }

  /**
   * Soft delete, refused while products still offer it.
   *
   * Same reasoning as a category in use: a product listing a size that no longer
   * resolves would render an unselectable option, and an order already placed in
   * that size keeps its own snapshot regardless.
   */
  async remove(id: string): Promise<void> {
    const size = await this.getDocumentOrThrow(id);

    const inUse = await this.productModel.countDocuments({ sizes: size._id, ...notDeleted });
    if (inUse > 0) {
      throw new ConflictException(
        `Cannot delete a size offered by ${inUse} product(s); remove it from them first`,
      );
    }

    size.deletedAt = new Date();
    size.isActive = false;
    size.code = `${size.code}-DELETED-${Date.now()}`;
    await size.save();
  }

  // -------------------------------------------------------------- resolution

  /**
   * Resolve the sizes a product is offered in, preserving the merchant's display
   * order rather than the order the ids happened to arrive in.
   *
   * Every id must exist. A silently dropped one would leave the product offering
   * fewer sizes than the admin selected, with nothing to say so.
   */
  async resolveMany(ids: string[]): Promise<ResolvedSize[]> {
    if (ids.length === 0) return [];

    const unique = [...new Set(ids)];
    const valid = unique.filter((id) => Types.ObjectId.isValid(id));
    const sizes = await this.sizeModel
      .find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) }, ...notDeleted })
      .sort({ order: 1, code: 1 })
      .exec();

    if (sizes.length !== unique.length) {
      const found = new Set(sizes.map((size) => size._id.toString()));
      throw new ValidationFailedException('One or more sizes do not exist', {
        unknown: unique.filter((id) => !found.has(id)),
      });
    }

    return sizes.map((size) => ({ id: size._id, name: size.name, code: size.code }));
  }

  /** Resolve one size, for an order line. */
  async resolveOne(id: string): Promise<ResolvedSize> {
    const size = await this.getDocumentOrThrow(id);
    return { id: size._id, name: size.name, code: size.code };
  }

  // ------------------------------------------------------------------ shared

  private visibilityFilter(includeInactive: boolean): FilterQuery<SizeDocument> {
    return { ...notDeleted, ...(includeInactive ? {} : { isActive: true }) };
  }

  private async getDocumentOrThrow(id: string): Promise<SizeDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Size', id);
    const size = await this.sizeModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!size) throw new ResourceNotFoundException('Size', id);
    return size;
  }

  private async assertCodeAvailable(code: string, excludeId?: Types.ObjectId): Promise<void> {
    const clash = await this.sizeModel.exists({
      code,
      ...notDeleted,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (clash) throw new ConflictException(`A size with code ${code} already exists`);
  }
}
