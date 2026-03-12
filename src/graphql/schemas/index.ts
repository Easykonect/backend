/**
 * GraphQL Type Definitions
 * Combined schema for the application
 * 
 * API Structure:
 * - UNIFIED: User (SERVICE_USER) and Service Provider (SERVICE_PROVIDER) share auth APIs
 * - SEPARATE: Admin and Super Admin have their own auth APIs
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

  enum ServiceStatus {
    DRAFT
    PENDING_APPROVAL
    ACTIVE
    INACTIVE
    SUSPENDED
  }

  # Admin role enum (subset for creation)
  enum AdminRole {
    ADMIN
    SUPER_ADMIN
  }

  # ==================
  # Types
  # ==================
  
  # Service Provider Profile (embedded in User when role is SERVICE_PROVIDER)
  type ServiceProviderProfile {
    id: ID!
    businessName: String!
    businessDescription: String
    verificationStatus: VerificationStatus!
    address: String!
    city: String!
    state: String!
    country: String!
    latitude: Float
    longitude: Float
    documents: [String!]!
    createdAt: String!
    updatedAt: String!
  }

  # Service Category
  type ServiceCategory {
    id: ID!
    name: String!
    slug: String!
    description: String
    icon: String
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  # Service
  type Service {
    id: ID!
    provider: ServiceProviderProfile!
    category: ServiceCategory!
    name: String!
    slug: String!
    description: String!
    price: Float!
    duration: Int!
    status: ServiceStatus!
    images: [String!]!
    createdAt: String!
    updatedAt: String!
  }

  # User - unified for SERVICE_USER and SERVICE_PROVIDER
  type User {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    phone: String
    role: UserRole!
    status: AccountStatus!
    isEmailVerified: Boolean!
    # Provider profile is only populated when role is SERVICE_PROVIDER
    providerProfile: ServiceProviderProfile
    createdAt: String!
    updatedAt: String!
  }

  # Admin User - separate type for clarity
  type AdminUser {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    role: UserRole!
    status: AccountStatus!
    lastLoginAt: String
    createdAt: String!
    updatedAt: String!
  }

  # ==================
  # Response Types
  # ==================

  type AuthResponse {
    user: User!
    accessToken: String!
    refreshToken: String!
  }

  type AdminAuthResponse {
    admin: AdminUser!
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

  type AdminRefreshTokenResponse {
    accessToken: String!
    admin: AdminUser!
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

  type PaginatedAdmins {
    items: [AdminUser!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  type PaginatedServices {
    items: [Service!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  type PaginatedCategories {
    items: [ServiceCategory!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # ==================
  # Input Types - User & Provider (Unified)
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

  input ChangePasswordInput {
    currentPassword: String!
    newPassword: String!
  }

  input PaginationInput {
    page: Int
    limit: Int
  }

  # Input for upgrading a SERVICE_USER to SERVICE_PROVIDER
  input BecomeProviderInput {
    businessName: String!
    businessDescription: String
    address: String!
    city: String!
    state: String!
    country: String!
    latitude: Float
    longitude: Float
  }

  # Input for updating provider profile
  input UpdateProviderProfileInput {
    businessName: String
    businessDescription: String
    address: String
    city: String
    state: String
    country: String
    latitude: Float
    longitude: Float
  }

  # ==================
  # Input Types - Service Management
  # ==================

  input CreateServiceInput {
    categoryId: ID!
    name: String!
    description: String!
    price: Float!
    duration: Int!
    images: [String!]
  }

  input UpdateServiceInput {
    categoryId: ID
    name: String
    description: String
    price: Float
    duration: Int
    images: [String!]
    status: ServiceStatus
  }

  input ServiceFiltersInput {
    categoryId: ID
    providerId: ID
    status: ServiceStatus
    minPrice: Float
    maxPrice: Float
    search: String
  }

  # ==================
  # Input Types - Admin (Separate)
  # ==================

  input AdminLoginInput {
    email: String!
    password: String!
  }

  input CreateAdminInput {
    email: String!
    password: String!
    firstName: String!
    lastName: String!
    role: AdminRole!
  }

  input UpdateAdminInput {
    firstName: String
    lastName: String
  }

  input AdminForgotPasswordInput {
    email: String!
  }

  input AdminResetPasswordInput {
    email: String!
    otp: String!
    newPassword: String!
  }

  input AdminChangePasswordInput {
    currentPassword: String!
    newPassword: String!
  }

  # ==================
  # Input Types - Categories (Admin)
  # ==================

  input CreateCategoryInput {
    name: String!
    description: String
    icon: String
  }

  input UpdateCategoryInput {
    name: String
    description: String
    icon: String
    isActive: Boolean
  }

  # ==================
  # Queries
  # ==================
  type Query {
    # ==================
    # User & Provider Queries (Unified)
    # ==================
    
    # Get current authenticated user (works for both USER and PROVIDER)
    me: User
    
    # Get user by ID
    user(id: ID!): User
    
    # List users with pagination (Admin only)
    users(pagination: PaginationInput): PaginatedUsers!

    # ==================
    # Service Queries (Public & Provider)
    # ==================
    
    # Get all service categories
    categories(pagination: PaginationInput): PaginatedCategories!
    
    # Get category by ID
    category(id: ID!): ServiceCategory
    
    # Get all services with filters
    services(filters: ServiceFiltersInput, pagination: PaginationInput): PaginatedServices!
    
    # Get service by ID
    service(id: ID!): Service
    
    # Get services by provider (for provider's own services)
    myServices(pagination: PaginationInput): PaginatedServices!

    # ==================
    # Admin Queries (Separate)
    # ==================
    
    # Get current authenticated admin
    adminMe: AdminUser
    
    # List all admins (SUPER_ADMIN only)
    admins(pagination: PaginationInput): PaginatedAdmins!
    
    # Get admin by ID (SUPER_ADMIN only)
    admin(id: ID!): AdminUser

    # Get providers pending verification (Admin)
    pendingProviders(pagination: PaginationInput): PaginatedUsers!
    
    # Get services pending approval (Admin)
    pendingServices(pagination: PaginationInput): PaginatedServices!
  }

  # ==================
  # Mutations
  # ==================
  type Mutation {
    # ==================
    # User & Provider Auth (Unified)
    # ==================
    
    # Register new user (creates SERVICE_USER by default)
    register(input: RegisterUserInput!): RegistrationResponse!
    
    # Verify email with OTP
    verifyEmail(input: VerifyEmailInput!): VerifyEmailResponse!
    
    # Resend verification OTP
    resendVerificationOtp(input: ResendOtpInput!): MessageResponse!
    
    # Login (works for SERVICE_USER and SERVICE_PROVIDER)
    login(input: LoginInput!): AuthResponse!
    
    # Refresh access token
    refreshToken(refreshToken: String!): RefreshTokenResponse!
    
    # Request password reset
    forgotPassword(input: ForgotPasswordInput!): MessageResponse!
    
    # Reset password with OTP
    resetPassword(input: ResetPasswordInput!): MessageResponse!
    
    # Change password (authenticated)
    changePassword(input: ChangePasswordInput!): MessageResponse!
    
    # Logout (invalidate refresh token)
    logout: MessageResponse!

    # ==================
    # User Profile (Unified)
    # ==================
    
    # Update user profile
    updateProfile(input: UpdateProfileInput!): User!
    
    # Delete own account
    deleteAccount: MessageResponse!

    # ==================
    # Service Provider (Upgrade & Management)
    # ==================
    
    # Upgrade from SERVICE_USER to SERVICE_PROVIDER
    becomeProvider(input: BecomeProviderInput!): User!
    
    # Update provider profile
    updateProviderProfile(input: UpdateProviderProfileInput!): User!

    # ==================
    # Service Management (Provider Only)
    # ==================
    
    # Create a new service
    createService(input: CreateServiceInput!): Service!
    
    # Update a service
    updateService(id: ID!, input: UpdateServiceInput!): Service!
    
    # Delete a service
    deleteService(id: ID!): MessageResponse!
    
    # Submit service for approval
    submitServiceForApproval(id: ID!): Service!

    # ==================
    # Admin Auth (Separate - Different Endpoints)
    # ==================
    
    # Admin login (only for ADMIN and SUPER_ADMIN roles)
    adminLogin(input: AdminLoginInput!): AdminAuthResponse!
    
    # Admin refresh token
    adminRefreshToken(refreshToken: String!): AdminRefreshTokenResponse!
    
    # Admin password reset request
    adminForgotPassword(input: AdminForgotPasswordInput!): MessageResponse!
    
    # Admin reset password with OTP
    adminResetPassword(input: AdminResetPasswordInput!): MessageResponse!
    
    # Admin change password
    adminChangePassword(input: AdminChangePasswordInput!): MessageResponse!
    
    # Admin logout
    adminLogout: MessageResponse!

    # ==================
    # Admin Profile Management
    # ==================
    
    # Update own admin profile
    updateAdminProfile(input: UpdateAdminInput!): AdminUser!

    # ==================
    # Admin Management (SUPER_ADMIN Only)
    # ==================
    
    # Create new admin (invite-based, SUPER_ADMIN only)
    createAdmin(input: CreateAdminInput!): RegistrationResponse!
    
    # Suspend admin
    suspendAdmin(adminId: ID!, reason: String!): MessageResponse!
    
    # Activate admin
    activateAdmin(adminId: ID!): MessageResponse!
    
    # Update admin role
    updateAdminRole(adminId: ID!, role: AdminRole!): AdminUser!
    
    # Delete admin
    deleteAdmin(adminId: ID!): MessageResponse!

    # ==================
    # User Management (Admin)
    # ==================
    
    # Suspend user
    suspendUser(userId: ID!, reason: String!): MessageResponse!
    
    # Activate user
    activateUser(userId: ID!): MessageResponse!
    
    # Delete user (Admin)
    deleteUser(id: ID!): MessageResponse!

    # ==================
    # Provider Verification (Admin)
    # ==================
    
    # Approve provider
    approveProvider(providerId: ID!): User!
    
    # Reject provider
    rejectProvider(providerId: ID!, reason: String!): User!

    # ==================
    # Service Moderation (Admin)
    # ==================
    
    # Approve service
    approveService(serviceId: ID!): Service!
    
    # Reject service
    rejectService(serviceId: ID!, reason: String!): Service!
    
    # Suspend service
    suspendService(serviceId: ID!, reason: String!): Service!

    # ==================
    # Category Management (Admin)
    # ==================
    
    # Create category
    createCategory(input: CreateCategoryInput!): ServiceCategory!
    
    # Update category
    updateCategory(id: ID!, input: UpdateCategoryInput!): ServiceCategory!
    
    # Delete category
    deleteCategory(id: ID!): MessageResponse!
  }
`;
