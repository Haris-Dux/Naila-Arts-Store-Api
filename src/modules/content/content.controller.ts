import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { ContentService } from './content.service';
import { SectionResponseDto, UpdateSectionDto } from './dto/content-section.dto';

/**
 * One pair of routes for every editable region of the storefront.
 *
 * Generic on purpose: a route per section would mean shipping a controller with
 * every "can we also edit the footer?", which is exactly the coupling the
 * section registry exists to remove.
 */
@ApiTags('content')
@Controller('content/sections')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Every storefront section, in one request' })
  @ApiResponse({ status: 200, type: [SectionResponseDto] })
  list(@CurrentUser() viewer?: AuthenticatedUser) {
    return this.contentService.list(ContentController.isStaff(viewer));
  }

  @Get(':key')
  @Public()
  @ApiOperation({ summary: 'One section by key' })
  @ApiResponse({ status: 200, type: SectionResponseDto })
  @ApiResponse({ status: 404, description: 'No such section, or it is unpublished' })
  findOne(@Param('key') key: string, @CurrentUser() viewer?: AuthenticatedUser) {
    return this.contentService.findByKey(key, ContentController.isStaff(viewer));
  }

  @Put(':key')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Replace a section's content" })
  @ApiResponse({ status: 200, type: SectionResponseDto })
  @ApiResponse({ status: 400, description: 'Content does not match the section’s shape' })
  @ApiResponse({ status: 404, description: 'No such section' })
  replace(
    @Param('key') key: string,
    @Body() dto: UpdateSectionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.contentService.replace(key, dto, actor);
  }

  /**
   * Reads are public so the storefront needs no token, but a signed-in
   * administrator reading the same route sees unpublished regions and entries
   * they have switched off — which is what lets the admin panel preview.
   */
  private static isStaff(viewer?: AuthenticatedUser): boolean {
    return viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
  }
}
