import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../enums/user-role.enum';
import { UserDocument } from '../schemas/user.schema';

/**
 * The only user shape that leaves the application.
 *
 * Built by an explicit field-by-field mapping rather than by spreading the
 * document, so adding a sensitive field to the schema can never silently add it
 * to an API response.
 */
export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) birthdate!: string | null;
  @ApiProperty() createdAt!: Date;

  // `this: void` so the method can be passed directly to `.map()` without
  // dragging an unintended receiver along.
  static fromDocument(this: void, user: UserDocument): UserResponseDto {
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      birthdate: user.birthdate ? user.birthdate.toISOString().slice(0, 10) : null,
      createdAt: user.createdAt,
    };
  }
}
