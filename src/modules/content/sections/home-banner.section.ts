import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SectionItemDto, defineSection, visibleItems } from './section-definition';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

/**
 * One slide. Images only, as specified — no heading, no caption, no call to
 * action. `alt` is not copy; it is the image's accessible name, and the same
 * field a product image carries.
 */
export class BannerSlideDto extends SectionItemDto {
  /**
   * `require_protocol` matters here: without it validator.js reads a bare word
   * as a hostname, so a typo would be stored and the storefront would render a
   * broken image. `require_tld` stays off so a self-hosted origin still works.
   */
  @ApiProperty({ example: 'https://cdn.example.com/banners/eid-sale.jpg' })
  @IsUrl(
    { require_tld: false, require_protocol: true, protocols: ['http', 'https'] },
    { message: 'Each banner needs a valid image URL' },
  )
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional({ description: 'Alt text, for accessibility' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  alt?: string;
}

export class HomeBannerSliderDto {
  @ApiProperty({ type: [BannerSlideDto], maxItems: 5 })
  @IsArray()
  @ArrayMaxSize(5, { message: 'The homepage slider takes at most 5 images' })
  @ValidateNested({ each: true })
  @Type(() => BannerSlideDto)
  items!: BannerSlideDto[];
}

export const homeBannerSliderSection = defineSection<HomeBannerSliderDto>({
  key: 'home_banner_slider',
  label: 'Homepage banner slider',
  description: 'Up to five images that rotate at the top of the homepage.',
  dto: HomeBannerSliderDto,
  // Empty rather than a placeholder image: a slider with nothing in it is a
  // storefront that renders no slider, which is the correct blank state.
  defaults: () => ({ items: [] }),
  publicView: visibleItems,
});
