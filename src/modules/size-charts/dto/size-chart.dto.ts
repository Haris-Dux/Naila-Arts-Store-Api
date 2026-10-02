import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ResolvedSize } from '../../sizes/sizes.service';
import { MEASUREMENTS, MEASUREMENT_KEYS, MeasurementGroup, MeasurementKey } from '../measurements';
import { SizeChartDocument } from '../schemas/size-chart.schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

export class SizeChartRowDto {
  /** Lower-cased, so the same size cannot be listed twice under two spellings. */
  @ApiProperty({ description: 'A size id, from GET /sizes' })
  @IsMongoId()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : (value as string),
  )
  sizeId!: string;

  @ApiProperty({
    type: [Number],
    example: [13.5, 18],
    description: 'One per measurement, in the order `measurements` lists them',
  })
  @IsArray()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { each: true, message: 'Each value must be a number with at most two decimals' },
  )
  @Min(0, { each: true })
  @Max(999, { each: true })
  values!: number[];
}

export class CreateSizeChartDto {
  @ApiProperty({ example: 'Polawn' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  @ApiPropertyOptional({ example: 'All mentioned sizes in inches', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Transform(trim)
  note?: string | null;

  @ApiProperty({ enum: MEASUREMENT_KEYS, isArray: true })
  @IsArray()
  @ArrayMinSize(1, { message: 'A size chart needs at least one measurement' })
  @ArrayUnique()
  @IsIn(MEASUREMENT_KEYS, { each: true })
  measurements!: MeasurementKey[];

  @ApiProperty({ type: [SizeChartRowDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'A size chart needs at least one size' })
  @ArrayMaxSize(50)
  @ArrayUnique((row: SizeChartRowDto | null | undefined) => row?.sizeId, {
    message: 'Each size may appear only once',
  })
  @ValidateNested({ each: true })
  @Type(() => SizeChartRowDto)
  rows!: SizeChartRowDto[];
}

/**
 * Every field optional. `rows` may be sent alone, valued in the chart's current
 * measurement order; `measurements` may not, since the values already stored
 * would then sit under different columns.
 */
export class UpdateSizeChartDto extends PartialType(CreateSizeChartDto) {}

export class SizeChartMeasurementDto {
  @ApiProperty({ enum: MEASUREMENT_KEYS }) key!: MeasurementKey;
  @ApiProperty({ example: 'Sleeve length' }) label!: string;
  /** Which of the chart's tables it is printed in. */
  @ApiProperty({ enum: ['SHIRT', 'TROUSER'] }) group!: MeasurementGroup;
}

export class SizeChartRowResponseDto {
  @ApiProperty() size!: { id: string; name: string; code: string };
  /** One per measurement, in the order of the chart's `measurements`. */
  @ApiProperty({ type: [Number] }) values!: number[];
}

export class SizeChartResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: [SizeChartMeasurementDto] }) measurements!: SizeChartMeasurementDto[];
  /** In the sizes' current display order. */
  @ApiProperty({ type: [SizeChartRowResponseDto] }) rows!: SizeChartRowResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  /** `sizes` is every size the chart lists, resolved and in display order. */
  static from(this: void, chart: SizeChartDocument, sizes: ResolvedSize[]): SizeChartResponseDto {
    const rows = new Map(chart.rows.map((row) => [row.sizeId.toString(), row.values]));

    return {
      id: chart._id.toString(),
      name: chart.name,
      note: chart.note,
      measurements: chart.measurements.map((key) => {
        const { label, group } = MEASUREMENTS.find((measurement) => measurement.key === key)!;
        return { key, label, group };
      }),
      rows: sizes.flatMap((size) => {
        const values = rows.get(size.id.toString());
        return values
          ? [{ size: { id: size.id.toString(), name: size.name, code: size.code }, values }]
          : [];
      }),
      createdAt: chart.createdAt,
      updatedAt: chart.updatedAt,
    };
  }
}
