import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SizeDocument } from '../schemas/size.schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

export class CreateSizeDto {
  @ApiProperty({ example: 'Medium' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  name!: string;

  @ApiProperty({ example: 'M', description: 'Short label; unique, upper-cased' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as string),
  )
  code!: string;

  @ApiPropertyOptional({ description: 'Display position, ascending', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSizeDto extends PartialType(CreateSizeDto) {}

export class ListSizesDto {
  @ApiPropertyOptional({ description: 'Include inactive sizes (staff only)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class SizeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty() order!: number;
  @ApiProperty() isActive!: boolean;

  static from(this: void, size: SizeDocument): SizeResponseDto {
    return {
      id: size._id.toString(),
      name: size.name,
      code: size.code,
      order: size.order,
      isActive: size.isActive,
    };
  }
}
