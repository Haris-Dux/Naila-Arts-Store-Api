import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OwnerOr } from '../auth/decorators/owner-or-role.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UserRole } from './enums/user-role.enum';
import { UsersService } from './users.service';

/**
 * Note what is missing: there is no public `POST /users`. Account creation lives
 * at `POST /auth/register`, which cannot accept a role. In the old gateway this
 * route was unauthenticated *and* the service granted administrator rights to
 * anyone registering as `admin@admin.com`.
 *
 * Profile edits and access-control changes are also separate endpoints, so the
 * privilege check for "change a role" is not entangled with "change a name".
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  @MinRole(UserRole.ADMIN)
  @ApiOperation({ summary: 'List users' })
  @ApiResponse({ status: 200, description: 'Paginated users' })
  @ApiResponse({ status: 403, description: 'Requires ADMIN or above' })
  list(@Query() query: ListUsersDto) {
    return this.usersService.list(query);
  }

  @Get(':id')
  @OwnerOr({ param: 'id', fallbackRole: UserRole.ADMIN })
  @ApiParam({ name: 'id', description: 'User id, or "me" for the caller' })
  @ApiOperation({ summary: 'Get a user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Patch(':id')
  @OwnerOr({ param: 'id', fallbackRole: UserRole.ADMIN })
  @ApiParam({ name: 'id', description: 'User id, or "me" for the caller' })
  @ApiOperation({ summary: 'Update profile fields (name, email, birthdate)' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Rejected — including any attempt to send role, isActive or password',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // UpdateUserDto has no role/isActive/password, and the global ValidationPipe
    // runs with forbidNonWhitelisted, so submitting one is a 400 rather than a
    // silent write. The actor is passed because the guard admits ADMIN for any
    // id, and the service still has to refuse editing an equal or senior account.
    return this.usersService.update(id, dto, actor);
  }

  @Patch(':id/access')
  @MinRole(UserRole.ADMIN)
  @ApiOperation({ summary: 'Change a user’s role or active status (admin)' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 403, description: 'Cannot grant a role at or above your own' })
  async updateAccess(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const { user, sessionsRevoked } = await this.usersService.adminUpdate(id, dto, actor);

    // A demoted or deactivated user must not keep browsing on a token that still
    // asserts the old role.
    if (sessionsRevoked) await this.authService.propagateRevocation(user.id);

    return user;
  }

  @Delete(':id')
  @MinRole(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a user' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'Would remove the last administrator' })
  async remove(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    await this.usersService.remove(id, actor);
    await this.authService.propagateRevocation(id);
  }
}
