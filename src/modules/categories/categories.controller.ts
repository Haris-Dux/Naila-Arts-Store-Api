import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { CategoriesService } from './categories.service';
import {
  CategoryResponseDto,
  CategoryTreeDto,
  CreateCategoryDto,
  ReorderCategoriesDto,
  ListCategoriesDto,
  UpdateCategoryDto,
} from './dto/category.dto';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List categories in display order' })
  @ApiResponse({ status: 200, type: [CategoryResponseDto] })
  list(@Query() query: ListCategoriesDto, @CurrentUser() viewer?: AuthenticatedUser) {
    return this.categoriesService.list(this.includeInactive(query, viewer));
  }

  /**
   * Declared before `:id`, or the parameter route would swallow `/tree`. Nest
   * matches handlers in declaration order.
   */
  @Get('tree')
  @Public()
  @ApiOperation({ summary: 'Top-level categories with their subcategories nested' })
  @ApiResponse({ status: 200, type: [CategoryTreeDto] })
  tree(@Query() query: ListCategoriesDto, @CurrentUser() viewer?: AuthenticatedUser) {
    return this.categoriesService.tree(this.includeInactive(query, viewer));
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a category' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findById(id);
  }

  @Post()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a top-level category or a subcategory' })
  @ApiResponse({ status: 409, description: 'Parent is itself a subcategory' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  /**
   * Declared before `:id` routes so the literal segment wins the match — a
   * `@Post('reorder')` after `@Post(':id')` would be read as an id.
   */
  @Post('reorder')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rewrite a branch’s display order from a dragged list (admin)',
    description:
      'Takes every child of one parent in its new order and assigns dense positions ' +
      '0..n-1. The list must be complete: a partial one means the client’s view is stale, ' +
      'and applying it would move categories nobody dragged.',
  })
  @ApiResponse({ status: 200, type: CategoryResponseDto, isArray: true })
  @ApiResponse({ status: 400, description: 'Ids are not all children of the given parent' })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  reorder(@Body() dto: ReorderCategoriesDto): Promise<CategoryResponseDto[]> {
    return this.categoriesService.reorder(dto);
  }

  @Patch(':id')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename, reorder, or re-parent a category' })
  @ApiResponse({ status: 409, description: 'The move would make the tree three levels deep' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    // Re-parenting also re-points every product placed in this branch, so the
    // two happen in one transaction inside the service.
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete an empty category' })
  @ApiResponse({ status: 409, description: 'Category still has products or subcategories' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.categoriesService.remove(id);
  }

  /**
   * Both listings are public so the storefront can render navigation without a
   * token, but the viewer is still resolved when one is present — that is what
   * lets staff preview a section before switching it on.
   */
  private includeInactive(query: ListCategoriesDto, viewer?: AuthenticatedUser): boolean {
    if (query.includeInactive !== true) return false;
    return viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
  }
}
