import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ContentSection, ContentSectionSchema } from './schemas/content-section.schema';

/**
 * Storefront content the client edits themselves.
 *
 * Depends on nothing but the database — content is read by the storefront and
 * written by the admin panel, and no domain module needs to know it exists.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ContentSection.name, schema: ContentSectionSchema }]),
  ],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
