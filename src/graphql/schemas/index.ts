/**
 * GraphQL Type Definitions
 * Combined schema for the application
 */

import gql from 'graphql-tag';

export const typeDefs = gql`
  # ==================
  # Enums
  # ==================
  enum UserRole {
    SERVICE_USER
    SERVICE_PROVIDER
    ADMIN
    SUPER_ADMIN
  }

  enum AccountStatus {
    PENDING
    ACTIVE
    SUSPENDED
    DEACTIVATED
  }

  enum VerificationStatus {
    UNVERIFIED
    PENDING
    VERIFIED
    REJECTED
  }

  enum BookingStatus {
    PENDING
    ACCEPTED
    REJECTED
    IN_PROGRESS
    COMPLETED
    CANCELLED
    DISPUTED
  }

  enum PaymentStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
    REFUNDED
  }

  # ==================
  # Types
  # ==================
  type User {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    phone: String
    role: UserRole!
    status: AccountStatus!
    isEmailVerified: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type AuthResponse {
    user: User!
    accessToken: String!
    refreshToken: String!
  }

  type RegistrationResponse {
    success: Boolean!
    message: String!
    requiresVerification: Boolean!
  }

  type VerifyEmailResponse {
    success: Boolean!
    message: String!
    user: User
    accessToken: String
    refreshToken: String
  }

  type MessageResponse {
    success: Boolean!
    message: String!
  }

  type RefreshTokenResponse {
    accessToken: String!
    user: User!
  }

  type PaginatedUsers {
    items: [User!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # ==================
  # Inputs
  # ==================
  input LoginInput {
    email: String!
    password: String!
  }

  input RegisterUserInput {
    email: String!
    password: String!
    firstName: String!
    lastName: String!
    phone: String
  }

  input VerifyEmailInput {
    email: String!
    otp: String!
  }

  input ResendOtpInput {
    email: String!
  }

  input ForgotPasswordInput {
    email: String!
  }

  input ResetPasswordInput {
    email: String!
    otp: String!
    newPassword: String!
  }

  input UpdateProfileInput {
    firstName: String
    lastName: String
    phone: String
  }

  input PaginationInput {
    page: Int
    limit: Int
  }

  # ==================
  # Queries
  # ==================
  type Query {
    # Auth
    me: User

    # Users
    user(id: ID!): User
    users(pagination: PaginationInput): PaginatedUsers!
  }

  # ==================
  # Mutations
  # ==================
  type Mutation {
    # Auth - Registration & Verification
    register(input: RegisterUserInput!): RegistrationResponse!
    verifyEmail(input: VerifyEmailInput!): VerifyEmailResponse!
    resendVerificationOtp(input: ResendOtpInput!): MessageResponse!
    
    # Auth - Login & Sessions
    login(input: LoginInput!): AuthResponse!
    refreshToken(refreshToken: String!): RefreshTokenResponse!
    
    # Auth - Password Management
    forgotPassword(input: ForgotPasswordInput!): MessageResponse!
    resetPassword(input: ResetPasswordInput!): MessageResponse!

    # Users
    updateProfile(input: UpdateProfileInput!): User!
    deleteUser(id: ID!): MessageResponse!
  }
`;
