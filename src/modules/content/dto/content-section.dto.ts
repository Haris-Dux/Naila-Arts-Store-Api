import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

export class UpdateSectionDto {
  /**
   * The section's content, in the shape its definition declares.
   *
   * Untyped here on purpose: the route is generic over every section, so the
   * real contract lives in the registry. `ContentService` validates this against
   * the section's own DTO with the same settings as the global pipe, so an
   * unknown key inside `data` is a 400 exactly as it would be anywhere else.
   */
  @ApiProperty({
    type: Object,
    description: "The section's content. GET the section first to see its shape.",
    example: { items: [{ text: '✨ Free delivery over Rs. 5000 ✨', isActive: true }] },
  })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Hide the whole region from the storefront without clearing it',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class SectionResponseDto {
  @ApiProperty({ example: 'announcement_bar' }) key!: string;
  @ApiProperty({ example: 'Announcement bar' }) label!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: Object }) data!: Record<string, unknown>;
  @ApiProperty() isPublished!: boolean;

  /** Null until an administrator has saved it — the defaults are being served. */
  @ApiPropertyOptional({ type: Date, nullable: true }) updatedAt!: Date | null;
}
