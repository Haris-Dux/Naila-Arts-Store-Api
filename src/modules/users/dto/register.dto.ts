import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Public registration payload.
 *
 * Note what is *absent*: there is no `role`. The old flow accepted a role on the
 * DTO and then assigned an administrator role to anyone who registered as
 * `admin@admin.com` — a full takeover in one unauthenticated request. Role is
 * never client-supplied here; the service always writes UserRole.USER, and the
 * first administrator is created at startup from SEED_ADMIN_* (AdminSeedService).
 */
export class RegisterDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MaxLength(120)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  name!: string;

  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as string),
  )
  email!: string;

  @ApiProperty({ example: 'StrongP@ss123', minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    { message: 'Password must include upper and lower case, a number and a symbol' },
  )
  password!: string;

  /**
   * ISO 8601 (`YYYY-MM-DD`), and genuinely optional.
   *
   * The old registration applied a `DD/MM/YYYY`-only pipe unconditionally to a
   * field marked @IsOptional, so omitting it threw a TypeError on
   * `undefined.split()` and any ISO date was rejected outright.
   */
  @ApiPropertyOptional({ example: '1990-01-31', description: 'ISO 8601 date' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'birthdate must be an ISO 8601 date (YYYY-MM-DD)' })
  birthdate?: string;
}
