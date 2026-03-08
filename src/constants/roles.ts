/**
 * User Roles
 * Defines all user roles in the platform
 */

export const UserRole = {
  SERVICE_USER: 'SERVICE_USER',
  SERVICE_PROVIDER: 'SERVICE_PROVIDER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;

export type UserRoleType = (typeof UserRole)[keyof typeof UserRole];

/**
 * Role hierarchy for permission checking
 * Higher index = higher privilege
 */
export const ROLE_HIERARCHY: UserRoleType[] = [
  UserRole.SERVICE_USER,
  UserRole.SERVICE_PROVIDER,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

/**
 * Check if a role has at least the required privilege level
 */
export const hasMinimumRole = (
  userRole: UserRoleType,
  requiredRole: UserRoleType
): boolean => {
  const userLevel = ROLE_HIERARCHY.indexOf(userRole);
  const requiredLevel = ROLE_HIERARCHY.indexOf(requiredRole);
  return userLevel >= requiredLevel;
};
