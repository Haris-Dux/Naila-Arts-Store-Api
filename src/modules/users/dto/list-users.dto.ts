import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { UserRole } from '../enums/user-role.enum';

/** Fields a client is permitted to sort by. */
export const USER_SORT_FIELDS = ['createdAt', 'name', 'email', 'role', 'lastLoginAt'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export class ListUsersDto extends PaginationDto {
  /**
   * Constrained to an allow-list. The old services interpolated this value
   * straight into a TypeORM `orderBy`, which is not parameterized — so
   * `?sort=` was an injection point. An unlisted field is now a 400 long before
   * it reaches the query builder.
   */
  @ApiPropertyOptional({ enum: USER_SORT_FIELDS, default: 'createdAt' })
  @IsIn(USER_SORT_FIELDS)
  @IsOptional()
  sort: UserSortField = 'createdAt';

  @ApiPropertyOptional({ description: 'Case-insensitive match on name or email' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  search?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  isActive?: boolean;
}
