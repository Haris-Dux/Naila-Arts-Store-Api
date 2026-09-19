import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole } from '../users/enums/user-role.enum';
import { MediaResponseDto } from './dto/media.dto';
import {
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  MediaService,
  UploadedFile,
} from './media.service';

/**
 * Uploads, admin-only.
 *
 * Reads do not come through here. Files are served by Express's static
 * middleware, mounted ahead of the Nest router — so fetching an image costs a
 * kernel `sendfile` and never runs the JWT guard, the throttler, or any
 * interceptor. Routing images through a controller would mean reading each one
 * into a Node buffer and paying the whole middleware stack per thumbnail.
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
    },
  })
  @ApiOperation({ summary: `Upload up to ${MAX_FILES_PER_UPLOAD} WebP images` })
  @ApiResponse({ status: 201, type: [MediaResponseDto] })
  @ApiResponse({ status: 400, description: 'Not a WebP, too large, or no file sent' })
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_UPLOAD, {
      // Held in memory: the size cap is small, the bytes have to be hashed
      // before anything else can happen, and a temp file would only add a
      // cleanup path that can fail.
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD },
    }),
  )
  upload(
    @UploadedFiles() files: UploadedFile[],
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MediaResponseDto[]> {
    // Several at once because that is how a product is created: the admin picks
    // its photographs together, gets the ids back, and posts the product.
    return this.mediaService.uploadMany(files ?? [], actor);
  }

  @Get()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Uploads, newest first by default — what is on the disk' })
  @ApiResponse({ status: 200, description: 'Paginated media' })
  list(@Query() query: PaginationDto) {
    return this.mediaService.list(query);
  }

  @Get(':id')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one upload’s metadata' })
  findOne(@Param('id') id: string) {
    return this.mediaService.findById(id);
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete an image no product uses' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 409, description: 'Still referenced by a product' })
  async remove(@Param('id') id: string): Promise<{ message: string }> {
    await this.mediaService.remove(id);
    return { message: 'Image deleted.' };
  }
}
