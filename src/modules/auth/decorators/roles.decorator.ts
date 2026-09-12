import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../users/enums/user-role.enum';

export const ROLES_KEY = 'requiredRole';

/**
 * Require at least this role. Ranked rather than exact, so a route states the
 * minimum it needs and stays correct if the role set grows.
 */
export const MinRole = (role: UserRole) => SetMetadata(ROLES_KEY, role);
