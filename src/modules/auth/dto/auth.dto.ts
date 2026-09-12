import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Matches,
  MaxLength,
} from 'class-validator';

const normaliseEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : (value as string);

export class LoginDto {
  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as string),
  )
  email!: string;

  // No strength rules on login — an existing password predates any policy
  // change, and rejecting it here would lock the account out rather than
  // failing the credential check.
  @ApiProperty({ example: 'StrongP@ss123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'The opaque refresh token issued at login' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MaxLength(128)
  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    { message: 'Password must include upper and lower case, a number and a symbol' },
  )
  newPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(normaliseEmail)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(normaliseEmail)
  email!: string;

  @ApiProperty({ example: '482913', description: 'The 6-digit code from the email' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be the 6-digit code from the email' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  code!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MaxLength(128)
  @IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    { message: 'Password must include upper and lower case, a number and a symbol' },
  )
  newPassword!: string;
}
