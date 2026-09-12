import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaDocument } from '../schemas/media.schema';

export class MediaResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Serve this. Immutable — safe to cache forever.' })
  url!: string;
  @ApiProperty({ example: 'image/webp' }) contentType!: string;
  @ApiProperty() bytes!: number;
  @ApiProperty({ description: 'Known up front so a grid can reserve the box' })
  width!: number;
  @ApiProperty() height!: number;
  @ApiPropertyOptional({ type: Date }) createdAt!: Date;

  static from(this: void, media: MediaDocument, url: string): MediaResponseDto {
    return {
      id: media._id.toString(),
      url,
      contentType: media.contentType,
      bytes: media.bytes,
      width: media.width,
      height: media.height,
      createdAt: media.createdAt,
    };
  }
}
