/**
 * Role & Authorization Tests
 * Tests role hierarchy and permission checking
 */

import { UserRole, ROLE_HIERARCHY, hasMinimumRole } from '@/constants/roles';

describe('Role Constants', () => {
  describe('UserRole', () => {
    it('should define all required roles', () => {
      expect(UserRole.SERVICE_USER).toBe('SERVICE_USER');
      expect(UserRole.SERVICE_PROVIDER).toBe('SERVICE_PROVIDER');
      expect(UserRole.ADMIN).toBe('ADMIN');
      expect(UserRole.SUPER_ADMIN).toBe('SUPER_ADMIN');
    });
  });

  describe('ROLE_HIERARCHY', () => {
    it('should have SERVICE_USER as the lowest privilege', () => {
      expect(ROLE_HIERARCHY.indexOf(UserRole.SERVICE_USER)).toBe(0);
    });

    it('should have SUPER_ADMIN as the highest privilege', () => {
      const lastIndex = ROLE_HIERARCHY.length - 1;
      expect(ROLE_HIERARCHY.indexOf(UserRole.SUPER_ADMIN)).toBe(lastIndex);
    });

    it('should have ADMIN with higher privilege than SERVICE_PROVIDER', () => {
      expect(ROLE_HIERARCHY.indexOf(UserRole.ADMIN)).toBeGreaterThan(
        ROLE_HIERARCHY.indexOf(UserRole.SERVICE_PROVIDER)
      );
    });
  });
});

describe('hasMinimumRole', () => {
  it('should return true when user has exactly the required role', () => {
    expect(hasMinimumRole(UserRole.ADMIN, UserRole.ADMIN)).toBe(true);
    expect(hasMinimumRole(UserRole.SERVICE_USER, UserRole.SERVICE_USER)).toBe(true);
  });

  it('should return true when user has a higher role than required', () => {
    expect(hasMinimumRole(UserRole.SUPER_ADMIN, UserRole.ADMIN)).toBe(true);
    expect(hasMinimumRole(UserRole.ADMIN, UserRole.SERVICE_PROVIDER)).toBe(true);
    expect(hasMinimumRole(UserRole.SUPER_ADMIN, UserRole.SERVICE_USER)).toBe(true);
  });

  it('should return false when user has a lower role than required', () => {
    expect(hasMinimumRole(UserRole.SERVICE_USER, UserRole.ADMIN)).toBe(false);
    expect(hasMinimumRole(UserRole.SERVICE_PROVIDER, UserRole.ADMIN)).toBe(false);
    expect(hasMinimumRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)).toBe(false);
  });

  it('should handle all role combinations correctly', () => {
    // Full matrix check
    const roles = [
      UserRole.SERVICE_USER,
      UserRole.SERVICE_PROVIDER,
      UserRole.ADMIN,
      UserRole.SUPER_ADMIN,
    ];

    roles.forEach((userRole, userIdx) => {
      roles.forEach((requiredRole, requiredIdx) => {
        const result = hasMinimumRole(userRole, requiredRole);
        expect(result).toBe(userIdx >= requiredIdx);
      });
    });
  });
});
