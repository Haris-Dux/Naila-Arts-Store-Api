import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

export class SuitDesignQueryDto {
  @ApiPropertyOptional({ description: 'Start of a design number', example: '87' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  search?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit: number = 20;
}

export class SuitColorQueryDto {
  @ApiProperty({ description: 'Design number, as returned by /erp/suits/designs' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Transform(trim)
  designNo!: string;

  /** Omitted for a design the ERP has filed under no category. */
  @ApiPropertyOptional({ description: 'The ERP category of that design' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  category?: string;
}

export class SuitDesignDto {
  @ApiProperty({ example: '871' }) designNo!: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Lawn' }) category!: string | null;
  @ApiProperty({ description: 'Colours of this design with stock' }) colorCount!: number;
  @ApiProperty({ description: 'Units across those colours' }) stock!: number;
}

export class SuitColorDto {
  @ApiProperty({ description: "The suit's _id — becomes a product colour's erpId" })
  suitId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Red' }) color!: string | null;
  @ApiProperty({ description: 'Units available' }) stock!: number;
}
