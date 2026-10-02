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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import {
  CreateSizeChartDto,
  SizeChartMeasurementDto,
  SizeChartResponseDto,
  UpdateSizeChartDto,
} from './dto/size-chart.dto';
import { SizeChartsService } from './size-charts.service';

@ApiTags('size-charts')
@Controller('size-charts')
export class SizeChartsController {
  constructor(private readonly sizeChartsService: SizeChartsService) {}

  /** Declared before `:id`, so the literal segment wins the match. */
  @Get('measurements')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The measurements a size chart can carry' })
  @ApiResponse({ status: 200, type: [SizeChartMeasurementDto] })
  measurements() {
    return this.sizeChartsService.measurements();
  }

  @Get()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List size charts by name' })
  @ApiResponse({ status: 200, type: [SizeChartResponseDto] })
  list() {
    return this.sizeChartsService.list();
  }

  /** Public: the storefront shows a product's chart by the id the product names. */
  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a size chart' })
  @ApiResponse({ status: 200, type: SizeChartResponseDto })
  @ApiResponse({ status: 404, description: 'Size chart not found' })
  findOne(@Param('id') id: string) {
    return this.sizeChartsService.findById(id);
  }

  @Post()
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a size chart' })
  @ApiResponse({ status: 201, type: SizeChartResponseDto })
  @ApiResponse({ status: 409, description: 'Name already in use' })
  create(@Body() dto: CreateSizeChartDto) {
    return this.sizeChartsService.create(dto);
  }

  @Patch(':id')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit a size chart' })
  @ApiResponse({ status: 200, type: SizeChartResponseDto })
  @ApiResponse({ status: 404, description: 'Size chart not found' })
  update(@Param('id') id: string, @Body() dto: UpdateSizeChartDto) {
    return this.sizeChartsService.update(id, dto);
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete a size chart no product uses' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 409, description: 'Size chart still used by products' })
  async remove(@Param('id') id: string): Promise<{ message: string }> {
    await this.sizeChartsService.remove(id);
    return { message: 'Size chart deleted.' };
  }
}
