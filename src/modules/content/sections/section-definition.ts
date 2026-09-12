import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClassConstructor } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * One editable region of the storefront, declared in code.
 *
 * A section owns three things: a stable `key` the storefront reads it by, a DTO
 * class describing the shape of its content, and the defaults to serve before
 * anyone has edited it. Nothing else in the system knows what a section
 * contains — storage is one collection of opaque documents and the API is one
 * pair of routes — so **adding a section is adding a file**: no schema change,
 * no migration, no new endpoint, no new module.
 *
 * That is the whole point of the indirection. The alternative, a collection and
 * a module per region, means every "can we also edit the footer?" is an
 * architectural change.
 */
export interface SectionDefinition<T extends object> {
  /** Stable identifier. Storefront code and URLs depend on it; never rename. */
  readonly key: string;

  /** Human label for the admin panel's section list. */
  readonly label: string;

  /** One line telling an administrator what editing this will change. */
  readonly description: string;

  /**
   * Validation contract for `data`. Validated with the same strictness as any
   * request body — unknown keys are rejected, not silently stored.
   */
  readonly dto: ClassConstructor<T>;

  /** Served until an administrator saves something. Never null, never empty. */
  readonly defaults: () => T;

  /**
   * Narrows the stored content to what a shopper may see — typically dropping
   * entries an administrator has switched off.
   *
   * Optional: a section with no per-entry visibility simply omits it. Keeping
   * this on the definition rather than in the service is what stops the
   * framework from having to assume every section is a list.
   */
  readonly publicView?: (data: T) => T;
}

/**
 * A definition with its type parameter erased, so the registry can hold sections
 * of different shapes in one array.
 *
 * `SectionDefinition<T>` is not assignable to `SectionDefinition<object>` —
 * `publicView` puts `T` in a parameter position — so the erasure happens once,
 * here, instead of at every use.
 */
export interface RegisteredSection {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly dto: ClassConstructor<object>;
  readonly defaults: () => object;
  readonly publicView: (data: object) => object;
}

/**
 * Registers a section, filling in the identity `publicView` when omitted.
 *
 * The cast is the erasure itself, and it is sound at runtime: content is
 * validated against `dto` before it is ever stored, so whatever reaches
 * `publicView` really is a `T`. Confining it to this one function is the point —
 * section authors and the service both work in fully checked types.
 */
export function defineSection<T extends object>(
  definition: SectionDefinition<T>,
): RegisteredSection {
  const publicView = definition.publicView ?? ((data: T) => data);

  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    dto: definition.dto,
    defaults: definition.defaults,
    publicView: publicView as unknown as (data: object) => object,
  };
}

/**
 * Base for one entry in a list-shaped section.
 *
 * `isActive` lets an administrator stage an entry, or retire one, without losing
 * the text they wrote. Order is the array's own order — a section is stored and
 * replaced as a single document, so there is no need for the explicit position
 * field that separate documents would require.
 */
export abstract class SectionItemDto {
  /**
   * Defaulted rather than left undefined so that what comes back is a real
   * boolean. An absent field would reach the storefront as `null`, which a
   * client checking `if (item.isActive)` would read as "hidden" — the exact
   * opposite of what omitting it means.
   */
  @ApiPropertyOptional({ description: 'Hidden from shoppers when false', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;
}

/** Shared shape of the list-based sections, and the filter they all want. */
export interface ItemisedSection<T extends SectionItemDto> {
  items: T[];
}

export function visibleItems<T extends SectionItemDto, S extends ItemisedSection<T>>(data: S): S {
  return { ...data, items: data.items.filter((item) => item.isActive !== false) };
}
