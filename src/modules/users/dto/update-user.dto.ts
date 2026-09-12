import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Self-service profile update. Reachable by the account owner.
 *
 * Deliberately narrow. It carries no `role`, no `isActive`, no `password` and no
 * `tokenVersion`. Combined with the global ValidationPipe's
 * `forbidNonWhitelisted`, submitting any of them is a 400 rather than a silent
 * write — which is what closes the privilege-escalation path where a user could
 * PATCH their own record with `{"role":"ADMIN"}` and have it persisted by
 * a blind object spread.
 *
 * Password changes go through POST /auth/change-password, which verifies the
 * current password and revokes existing sessions. Role changes go through the
 * admin-only endpoint.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  name?: string;

  @ApiPropertyOptional({ example: 'jane@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as string),
  )
  email?: string;

  @ApiPropertyOptional({ example: '1990-01-31', description: 'ISO 8601 date' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'birthdate must be an ISO 8601 date (YYYY-MM-DD)' })
  birthdate?: string;
}
