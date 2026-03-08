/**
 * Authentication Types
 */

import type { UserRoleType } from '@/constants';

/**
 * Login input
 */
export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Register input for service users
 */
export interface RegisterUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

/**
 * Register input for service providers
 */
export interface RegisterProviderInput extends RegisterUserInput {
  businessName: string;
  businessDescription?: string;
  serviceCategories: string[];
  location: LocationInput;
}

/**
 * Location input
 */
export interface LocationInput {
  address: string;
  city: string;
  state: string;
  country: string;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

/**
 * Auth response
 */
export interface AuthResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRoleType;
  };
  accessToken: string;
  refreshToken: string;
}

/**
 * Token payload from JWT
 */
export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRoleType;
  iat: number;
  exp: number;
}
