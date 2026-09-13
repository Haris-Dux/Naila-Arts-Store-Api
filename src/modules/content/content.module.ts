import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MediaModule } from '../media/media.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ContentSection, ContentSectionSchema } from './schemas/content-section.schema';

/**
 * Storefront content the client edits themselves.
 *
 * Content is read by the storefront and written by the admin panel, and no
 * domain module needs to know it exists. Its one dependency is media: saving a
 * section deletes the images it no longer shows.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ContentSection.name, schema: ContentSectionSchema }]),
    MediaModule,
  ],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
