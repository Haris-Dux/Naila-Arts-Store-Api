import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { SectionItemDto, defineSection, visibleItems } from './section-definition';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

export class AnnouncementDto extends SectionItemDto {
  @ApiProperty({ example: '✨ Easy Return & Exchange Policy ✨' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(trim)
  text!: string;
}

export class AnnouncementBarDto {
  /**
   * The strip cycles through these in order.
   *
   * Capped like every other array on this API: an unbounded list in a single
   * document is a document-size problem waiting to happen, and a bar with fifty
   * messages is a mistake rather than a feature.
   */
  @ApiProperty({ type: [AnnouncementDto], maxItems: 10 })
  @IsArray()
  @ArrayMaxSize(10, { message: 'The announcement bar holds at most 10 messages' })
  @ValidateNested({ each: true })
  @Type(() => AnnouncementDto)
  items!: AnnouncementDto[];
}

export const announcementBarSection = defineSection<AnnouncementBarDto>({
  key: 'announcement_bar',
  label: 'Announcement bar',
  description: 'The rotating message strip above the site header.',
  dto: AnnouncementBarDto,
  defaults: () => ({ items: [{ text: '✨ Easy Return & Exchange Policy ✨' }] }),
  publicView: visibleItems,
});
