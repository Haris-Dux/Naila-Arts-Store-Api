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
import { UserRole } from '../users/enums/user-role.enum';
import { ListProductsDto } from './dto/list-products.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Browse products',
    description:
      'Two pagination modes over the same filters. `paginate=page` (default) returns ' +
      'numbered pages with a total — what a table with page controls needs. ' +
      '`paginate=cursor` returns an opaque `meta.nextCursor` and is what an infinite ' +
      'scroll needs: it anchors to a position in the ordering, so publishing or ' +
      'removing a product mid-scroll cannot make the reader see an item twice or miss ' +
      'one, which offset paging does. Cursor mode rejects `sort=relevance`.',
  })
  @ApiResponse({ status: 200, description: 'Paginated products' })
  @ApiResponse({
    status: 400,
    description: 'Unsupported sort field, malformed filter, malformed cursor, or cursor+relevance',
  })
  list(@Query() query: ListProductsDto, @CurrentUser() viewer?: AuthenticatedUser) {
    // Public, but the viewer is still resolved when a token is present — that is
    // what lets staff see inactive products through the same endpoint.
    return query.paginate === 'cursor'
      ? this.productsService.feed(query, viewer)
      : this.productsService.list(query, viewer);
  }

  @Get('slug/:slug')
  @Public()
  @ApiOperation({ summary: 'Get a product by its storefront slug' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a product' })
  @ApiResponse({ status: 200, type: ProductResponseDto })
  @ApiResponse({ status: 404, description: 'Product not found' })
  findOne(@Param('id') id: string, @CurrentUser() viewer?: AuthenticatedUser) {
    return this.productsService.findById(id, viewer);
  }

  @Post()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product' })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  @ApiResponse({ status: 409, description: 'SKU already in use' })
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a product' })
  @ApiResponse({ status: 200, type: ProductResponseDto })
  @ApiResponse({ status: 404, description: 'Product not found' })
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    // `stock` is not on UpdateProductDto — see the inventory endpoints.
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a product' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async remove(@Param('id') id: string): Promise<{ message: string }> {
    await this.productsService.remove(id);
    return { message: 'Product deleted.' };
  }
}
