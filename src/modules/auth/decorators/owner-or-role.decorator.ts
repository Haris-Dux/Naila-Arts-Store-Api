import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../users/enums/user-role.enum';

export const OWNERSHIP_KEY = 'ownership';

export interface OwnershipOptions {
  /** Route parameter holding the owner's id. */
  param: string;
  /** Role that may act on anyone's resource, bypassing the ownership check. */
  fallbackRole?: UserRole;
}

/**
 * Permit the resource owner, or a sufficiently senior role.
 *
 *   @OwnerOr({ param: 'id', fallbackRole: UserRole.ADMIN })
 */
export const OwnerOr = (options: OwnershipOptions) => SetMetadata(OWNERSHIP_KEY, options);
