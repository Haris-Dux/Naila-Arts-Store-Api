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
import { CreateSizeDto, ListSizesDto, SizeResponseDto, UpdateSizeDto } from './dto/size.dto';
import { SizesService } from './sizes.service';

@ApiTags('sizes')
@Controller('sizes')
export class SizesController {
  constructor(private readonly sizesService: SizesService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List sizes in display order' })
  @ApiResponse({ status: 200, type: [SizeResponseDto] })
  list(@Query() query: ListSizesDto, @CurrentUser() viewer?: AuthenticatedUser) {
    // Public, but a signed-in administrator may ask for the inactive ones too —
    // the same rule the product and category listings follow.
    const staff = viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
    return this.sizesService.list(query.includeInactive === true && staff);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a size' })
  @ApiResponse({ status: 404, description: 'Size not found' })
  findOne(@Param('id') id: string) {
    return this.sizesService.findById(id);
  }

  @Post()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a size' })
  @ApiResponse({ status: 409, description: 'Code already in use' })
  create(@Body() dto: CreateSizeDto) {
    return this.sizesService.create(dto);
  }

  @Patch(':id')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rename or reorder a size' })
  update(@Param('id') id: string, @Body() dto: UpdateSizeDto) {
    return this.sizesService.update(id, dto);
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a size no product offers' })
  @ApiResponse({ status: 409, description: 'Size still offered by products' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.sizesService.remove(id);
  }
}
