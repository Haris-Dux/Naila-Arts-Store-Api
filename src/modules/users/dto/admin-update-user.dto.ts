import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { UserRole } from '../enums/user-role.enum';
import { UpdateUserDto } from './update-user.dto';

/**
 * Privileged update. Only reachable through the admin route, which is guarded by
 * RolesGuard at ADMIN. Demoting or deactivating the last administrator is
 * refused by the service, so the dashboard cannot be locked out.
 */
export class AdminUpdateUserDto extends UpdateUserDto {
  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: 'Deactivating blocks login without deleting history' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
