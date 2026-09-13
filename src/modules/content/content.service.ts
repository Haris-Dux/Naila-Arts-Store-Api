import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { Model, Types } from 'mongoose';
import {
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { MediaService } from '../media/media.service';
import { SectionResponseDto, UpdateSectionDto } from './dto/content-section.dto';
import { ContentSection, ContentSectionDocument } from './schemas/content-section.schema';
import { SECTION_REGISTRY } from './sections';
import { RegisteredSection } from './sections/section-definition';

/**
 * Reads and writes the editable regions of the storefront.
 *
 * The service is generic over every section: it never names one. What a section
 * contains, what it defaults to, and what a shopper is allowed to see all come
 * from its `SectionDefinition`, which is why adding a region needs no change
 * here.
 */
@Injectable()
export class ContentService {
  private readonly definitions: ReadonlyMap<string, RegisteredSection> = new Map(
    SECTION_REGISTRY.map((definition) => [definition.key, definition]),
  );

  constructor(
    @InjectModel(ContentSection.name)
    private readonly sectionModel: Model<ContentSectionDocument>,
    private readonly media: MediaService,
  ) {}

  // ------------------------------------------------------------------- reads

  /**
   * Every section in one response, so the storefront fetches its chrome once.
   *
   * Driven by the registry, not by the collection: a section nobody has edited
   * still appears, carrying its defaults. A stored row whose definition has been
   * removed is ignored rather than served as an unrecognised blob.
   */
  async list(staff: boolean): Promise<SectionResponseDto[]> {
    const stored = await this.sectionModel.find({ ...notDeleted }).exec();
    const byKey = new Map(stored.map((document) => [document.key, document]));

    return SECTION_REGISTRY.map((definition) =>
      this.present(definition, byKey.get(definition.key), staff),
    ).filter((section): section is SectionResponseDto => section !== null);
  }

  async findByKey(key: string, staff: boolean): Promise<SectionResponseDto> {
    const definition = this.definitionOrThrow(key);
    const document = await this.sectionModel.findOne({ key, ...notDeleted }).exec();

    const section = this.present(definition, document, staff);
    // An unpublished section is a 404 to a shopper, not an empty 200 — the same
    // treatment an inactive product gets, so its existence cannot be probed.
    if (!section) throw new ResourceNotFoundException('Content section', key);
    return section;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Replaces a section's content outright.
   *
   * A replace rather than a merge, because every section's content is a list and
   * merging lists is ambiguous — there is no honest answer to what a patch
   * containing two of five banners means. The admin panel sends back what it
   * rendered, so a concurrent edit is last-writer-wins on the whole region
   * rather than an interleaving nobody can reason about.
   */
  async replace(
    key: string,
    dto: UpdateSectionDto,
    actor: AuthenticatedUser,
  ): Promise<SectionResponseDto> {
    const definition = this.definitionOrThrow(key);
    const data = await this.validate(definition, dto.data);

    // Read before the write, to learn which images this save takes out.
    const previous = await this.sectionModel.findOne({ key }).select('data').lean().exec();

    const saved = await this.sectionModel
      .findOneAndUpdate(
        { key },
        {
          $set: {
            data,
            isPublished: dto.isPublished ?? true,
            updatedBy: new Types.ObjectId(actor.id),
            deletedAt: null,
          },
        },
        { new: true, upsert: true },
      )
      .exec();

    // An image dropped from the section is deleted once nothing else uses it —
    // otherwise every banner ever replaced would stay in storage for good. After
    // the write, so the usage check sees the section as it now is.
    const kept = new Set(ContentService.imageUrls(data));
    const dropped = ContentService.imageUrls(previous?.data).filter((url) => !kept.has(url));
    if (dropped.length > 0) await this.media.releaseUnused(dropped);

    // Returned as staff see it: the caller is an administrator, and echoing back
    // a filtered copy of what they just saved would be actively confusing.
    // Never null for staff — `present` only withholds an unpublished section
    // from shoppers.
    return this.present(definition, saved, true)!;
  }

  // ------------------------------------------------------------------ shared

  /**
   * The `url` of every entry in a section's `items`.
   *
   * Read off the stored shape rather than any one section's DTO, so a future
   * section with images is covered without a change here. A section with no
   * `url` fields — the announcement bar — simply yields nothing.
   */
  private static imageUrls(data: unknown): string[] {
    const items = (data as { items?: unknown } | null | undefined)?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => (item as { url?: unknown } | null)?.url)
      .filter((url): url is string => typeof url === 'string');
  }

  private definitionOrThrow(key: string): RegisteredSection {
    const definition = this.definitions.get(key);
    if (!definition) throw new ResourceNotFoundException('Content section', key);
    return definition;
  }

  private present(
    definition: RegisteredSection,
    document: ContentSectionDocument | undefined | null,
    staff: boolean,
  ): SectionResponseDto | null {
    const isPublished = document?.isPublished ?? true;
    if (!staff && !isPublished) return null;

    const stored = document?.data ?? (definition.defaults() as Record<string, unknown>);

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      // Staff see everything, including entries they have switched off; the
      // storefront sees only what is live.
      data: (staff ? stored : definition.publicView(stored)) as Record<string, unknown>,
      isPublished,
      updatedAt: document?.updatedAt ?? null,
    };
  }

  /**
   * Validates incoming content against the section's own DTO.
   *
   * Deliberately the same settings as the global `ValidationPipe`: the generic
   * route means the pipe cannot know this shape, so refusing unknown keys here
   * is what stops `/content/sections/:key` being the one endpoint on the API
   * that quietly accepts anything.
   */
  private async validate(definition: RegisteredSection, data: unknown): Promise<object> {
    const instance = plainToInstance(definition.dto, data ?? {});

    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
      throw new ValidationFailedException(`"${definition.label}" content is not valid`, {
        errors: ContentService.flatten(errors),
      });
    }

    // Back to a plain object: storing a class instance would persist whatever
    // class-transformer decides to carry along with it. `exposeUnsetFields`
    // keeps optional fields the administrator left blank out of the document
    // altogether, rather than storing them as nulls the storefront has to
    // second-guess.
    return instanceToPlain(instance, { exposeUnsetFields: false });
  }

  /** Flattens nested errors to `items.0.text must be a string` style messages. */
  private static flatten(errors: ValidationError[], path = ''): string[] {
    return errors.flatMap((error) => {
      const here = path ? `${path}.${error.property}` : error.property;
      const own = Object.values(error.constraints ?? {}).map((message) =>
        // class-validator names the leaf property; prefix the full path so the
        // administrator knows which of five banners is wrong.
        path ? `${path}.${message}` : message,
      );
      return [...own, ...ContentService.flatten(error.children ?? [], here)];
    });
  }
}
