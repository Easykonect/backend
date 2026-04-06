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

  enum DisputeStatus {
    OPEN
    UNDER_REVIEW
    RESOLVED
    CLOSED
  }

  enum DisputeResolution {
    REFUND_FULL
    REFUND_PARTIAL
    NO_REFUND
    REDO_SERVICE
    MUTUAL_AGREEMENT
    DISMISSED
  }

  enum ConversationType {
    USER_PROVIDER
    USER_ADMIN
    ADMIN_SUPERADMIN
    BOOKING_RELATED
  }

  enum MessageStatus {
    SENT
    DELIVERED
    READ
  }

  enum NotificationType {
    BOOKING_CREATED
    BOOKING_ACCEPTED
    BOOKING_REJECTED
    BOOKING_CANCELLED
    BOOKING_STARTED
    BOOKING_COMPLETED
    PAYMENT_RECEIVED
    PAYMENT_FAILED
    REFUND_PROCESSED
    REVIEW_RECEIVED
    REVIEW_RESPONSE
    VERIFICATION_APPROVED
    VERIFICATION_REJECTED
    SERVICE_APPROVED
    SERVICE_REJECTED
    SERVICE_SUSPENDED
    DISPUTE_OPENED
    DISPUTE_UPDATED
    DISPUTE_RESOLVED
    NEW_MESSAGE
    ACCOUNT_SUSPENDED
    ACCOUNT_ACTIVATED
    SYSTEM_ANNOUNCEMENT
  }

  # Admin role enum (subset for creation)
  enum AdminRole {
    ADMIN
    SUPER_ADMIN
  }

  # Wallet transaction types
  enum WalletTransactionType {
    CREDIT
    DEBIT
  }

  # Wallet transaction sources
  enum WalletTransactionSource {
    REFUND
    BOOKING_PAYMENT
    EARNING
    WITHDRAWAL
    ADMIN_ADJUSTMENT
    PAYOUT
  }

  # Withdrawal status
  enum WithdrawalStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
    CANCELLED
  }

  # Payout frequency for providers
  enum PayoutFrequency {
    INSTANT
    DAILY
    WEEKLY
    BIWEEKLY
    MONTHLY
  }

  # Admin actions for audit logging
  enum AdminAction {
    BAN_USER
    UNBAN_USER
    RESTRICT_USER
    REMOVE_RESTRICTION
    SUSPEND_USER
    ACTIVATE_USER
    PROCESS_WITHDRAWAL
    REJECT_WITHDRAWAL
    ADJUST_WALLET
    RESOLVE_DISPUTE
    PROCESS_REFUND
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
    images: [String!]!
    averageRating: Float
    totalReviews: Int
    likeCount: Int
    isLiked: Boolean
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

  # Booking
  type Booking {
    id: ID!
    user: User!
    provider: ServiceProviderProfile!
    service: Service!
    status: BookingStatus!
    scheduledDate: String!
    scheduledTime: String!
    address: String!
    city: String!
    state: String!
    notes: String
    servicePrice: Float!
    commission: Float!
    totalAmount: Float!
    payment: Payment
    review: Review
    completedAt: String
    cancelledAt: String
    cancellationReason: String
    createdAt: String!
    updatedAt: String!
  }

  # Payment
  type Payment {
    id: ID!
    bookingId: ID!
    amount: Float!
    commission: Float!
    providerPayout: Float!
    status: PaymentStatus!
    paymentMethod: String
    transactionRef: String
    paidAt: String
    refundedAt: String
    createdAt: String!
    updatedAt: String!
  }

  # Review
  type Review {
    id: ID!
    rating: Int!
    comment: String
    response: String
    respondedAt: String
    createdAt: String!
    updatedAt: String!
    user: ReviewUser
    provider: ReviewProvider
    booking: ReviewBooking
  }

  type ReviewUser {
    id: ID!
    firstName: String!
    lastName: String!
    email: String!
  }

  type ReviewProvider {
    id: ID!
    businessName: String!
    user: ReviewProviderUser
  }

  type ReviewProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
  }

  type ReviewBooking {
    id: ID!
    scheduledDate: String!
    service: ReviewService
  }

  type ReviewService {
    id: ID!
    title: String!
  }

  # Paginated Reviews
  type PaginatedReviews {
    reviews: [Review!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Provider Rating Stats
  type ProviderRatingStats {
    averageRating: Float!
    totalReviews: Int!
    fiveStars: Int!
    fourStars: Int!
    threeStars: Int!
    twoStars: Int!
    oneStar: Int!
  }

  # Can Review Response
  type CanReviewResponse {
    canReview: Boolean!
    reason: String
  }

  # ==================
  # Favourite Types
  # ==================

  # Favourite
  type Favourite {
    id: ID!
    createdAt: String!
    service: FavouriteService
  }

  # Service details in favourite
  type FavouriteService {
    id: ID!
    name: String!
    slug: String!
    description: String!
    price: Float!
    duration: Int!
    status: ServiceStatus!
    images: [String!]!
    createdAt: String!
    updatedAt: String!
    category: FavouriteCategory
    provider: FavouriteProvider
  }

  type FavouriteCategory {
    id: ID!
    name: String!
    slug: String!
    icon: String
  }

  type FavouriteProvider {
    id: ID!
    businessName: String!
    verificationStatus: VerificationStatus!
    city: String!
    state: String!
    user: FavouriteProviderUser
  }

  type FavouriteProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
  }

  # Paginated Favourites
  type PaginatedFavourites {
    favourites: [Favourite!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Is Favourited Response
  type IsFavouritedResponse {
    isFavourited: Boolean!
    favouriteId: ID
  }

  # Toggle Favourite Response
  type ToggleFavouriteResponse {
    isFavourited: Boolean!
    message: String!
  }

  # Service Favourite Count Response
  type ServiceFavouriteCountResponse {
    count: Int!
  }

  # ==================
  # Provider Like Types
  # ==================

  # Provider Like Response
  type ProviderLikeResponse {
    success: Boolean!
    message: String!
    likeCount: Int!
  }

  # Toggle Provider Like Response
  type ToggleProviderLikeResponse {
    success: Boolean!
    message: String!
    isLiked: Boolean!
    likeCount: Int!
  }

  # Is Provider Liked Response
  type IsProviderLikedResponse {
    isLiked: Boolean!
    likeCount: Int!
  }

  # Liked Provider Item
  type LikedProviderItem {
    id: ID!
    likedAt: String!
    provider: LikedProviderDetails!
  }

  # Liked Provider Details
  type LikedProviderDetails {
    id: ID!
    businessName: String!
    businessDescription: String
    verificationStatus: VerificationStatus!
    city: String!
    state: String!
    images: [String!]!
    user: LikedProviderUser
    reviewCount: Int!
    likeCount: Int!
  }

  # Liked Provider User
  type LikedProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
    profilePhoto: String
  }

  # Paginated Liked Providers
  type PaginatedLikedProviders {
    items: [LikedProviderItem!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # ==================
  # Browse / Discovery Types
  # ==================

  # A single provider card returned by browse/nearby queries
  type BrowseProviderItem {
    id: ID!
    businessName: String!
    businessDescription: String
    verificationStatus: VerificationStatus!
    address: String
    city: String!
    state: String!
    country: String!
    latitude: Float
    longitude: Float
    images: [String!]!
    averageRating: Float!
    totalReviews: Int!
    likeCount: Int!
    distanceKm: Float
    categories: [String!]!
    user: BrowseProviderUser
    createdAt: String!
    updatedAt: String!
  }

  type BrowseProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
    profilePhoto: String
  }

  # Active service shown on a provider's full public profile
  type ProviderActiveService {
    id: ID!
    name: String!
    price: Float!
    duration: Int!
    images: [String!]!
    category: ServiceCategory
  }

  # Full public profile of a provider (for the detail page)
  type PublicProviderProfile {
    id: ID!
    businessName: String!
    businessDescription: String
    verificationStatus: VerificationStatus!
    address: String
    city: String!
    state: String!
    country: String!
    latitude: Float
    longitude: Float
    images: [String!]!
    averageRating: Float!
    totalReviews: Int!
    likeCount: Int!
    distanceKm: Float
    categories: [String!]!
    user: BrowseProviderUser
    activeServices: [ProviderActiveService!]!
    createdAt: String!
    updatedAt: String!
  }

  # Paginated browse results
  type PaginatedBrowseProviders {
    items: [BrowseProviderItem!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Paginated nearby results (includes search metadata)
  type PaginatedNearbyProviders {
    items: [BrowseProviderItem!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    radiusKm: Float!
    searchLocation: SearchLocation!
  }

  type SearchLocation {
    latitude: Float!
    longitude: Float!
  }

  # ==================
  # Dispute Types
  # ==================

  # Dispute
  type Dispute {
    id: ID!
    reason: String!
    description: String!
    evidence: [String!]!
    status: DisputeStatus!
    raisedByRole: UserRole!
    resolution: DisputeResolution
    resolutionNotes: String
    refundAmount: Float
    resolvedAt: String
    createdAt: String!
    updatedAt: String!
    booking: DisputeBooking
  }

  type DisputeBooking {
    id: ID!
    status: BookingStatus!
    scheduledDate: String!
    scheduledTime: String!
    servicePrice: Float!
    totalAmount: Float!
    user: DisputeUser
    provider: DisputeProvider
    service: DisputeService
  }

  type DisputeUser {
    id: ID!
    firstName: String!
    lastName: String!
    email: String!
  }

  type DisputeProvider {
    id: ID!
    businessName: String!
    user: DisputeProviderUser
  }

  type DisputeProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
    email: String!
  }

  type DisputeService {
    id: ID!
    name: String!
    price: Float!
  }

  # Paginated Disputes
  type PaginatedDisputes {
    disputes: [Dispute!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Open Disputes Count Response
  type OpenDisputesCountResponse {
    count: Int!
  }

  # Dispute Statistics
  type DisputeStats {
    total: Int!
    open: Int!
    underReview: Int!
    resolved: Int!
    closed: Int!
    pending: Int!
    resolutions: DisputeResolutionBreakdown
  }

  type DisputeResolutionBreakdown {
    REFUND_FULL: Int
    REFUND_PARTIAL: Int
    NO_REFUND: Int
    REDO_SERVICE: Int
    MUTUAL_AGREEMENT: Int
    DISMISSED: Int
  }

  # Booking Statistics
  type BookingStats {
    totalBookings: Int!
    pendingBookings: Int!
    completedBookings: Int!
    cancelledBookings: Int!
    totalRevenue: Float
    totalSpent: Float
    completionRate: Float
  }

  # User - unified for SERVICE_USER and SERVICE_PROVIDER
  type User {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    phone: String
    profilePhoto: String
    role: UserRole!
    activeRole: UserRole!  # Current active mode (for role switching)
    status: AccountStatus!
    isEmailVerified: Boolean!
    pushEnabled: Boolean!   # Whether push notifications are enabled
    lastLoginAt: String     # ISO timestamp of last login
    # Provider profile is only populated when role is SERVICE_PROVIDER
    providerProfile: ServiceProviderProfile
    createdAt: String!
    updatedAt: String!
  }

  # Active Role Status
  type ActiveRoleStatus {
    currentRole: UserRole!
    activeRole: UserRole!
    canSwitch: Boolean!
    hasProviderProfile: Boolean!
    message: String!
  }

  # Admin User - separate type for clarity
  type AdminUser {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    phone: String
    profilePhoto: String
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

  type BecomeProviderResponse {
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

  type VerificationStatusResponse {
    status: VerificationStatus!
    canSubmit: Boolean!
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

  type PaginatedBookings {
    items: [Booking!]!
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
    profilePhoto: String
  }

  input RequestEmailChangeInput {
    newEmail: String!
  }

  input ConfirmEmailChangeInput {
    otp: String!
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
    profilePhoto: String
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
  # Input Types - Browse / Discovery
  # ==================

  enum ProviderSortBy {
    RATING_DESC
    POPULARITY_DESC
    NEWEST
    NAME_ASC
  }

  input ProviderFiltersInput {
    city: String
    state: String
    country: String
    categoryId: ID
    verifiedOnly: Boolean
    minRating: Float
  }

  input BrowseProvidersInput {
    filters: ProviderFiltersInput
    sortBy: ProviderSortBy
    pagination: PaginationInput
  }

  input NearbyProvidersInput {
    latitude: Float!
    longitude: Float!
    radiusKm: Float
    filters: ProviderFiltersInput
    sortBy: ProviderSortBy
    pagination: PaginationInput
  }

  # ==================
  # Input Types - Booking Management
  # ==================

  input CreateBookingInput {
    serviceId: ID!
    scheduledDate: String!
    scheduledTime: String!
    address: String!
    city: String!
    state: String!
    notes: String
  }

  input UpdateBookingInput {
    scheduledDate: String
    scheduledTime: String
    address: String
    city: String
    state: String
    notes: String
  }

  input BookingFiltersInput {
    status: BookingStatus
    startDate: String
    endDate: String
  }

  # ==================
  # Input Types - Reviews
  # ==================

  input CreateReviewInput {
    bookingId: ID!
    rating: Int!
    comment: String
  }

  input UpdateReviewInput {
    rating: Int
    comment: String
  }

  input ReviewFiltersInput {
    rating: Int
    hasResponse: Boolean
  }

  # ==================
  # Input Types - Disputes
  # ==================

  input CreateDisputeInput {
    bookingId: ID!
    reason: String!
    description: String!
    evidence: [String!]
  }

  input ResolveDisputeInput {
    resolution: DisputeResolution!
    resolutionNotes: String!
    refundAmount: Float
  }

  input DisputeFiltersInput {
    status: DisputeStatus
    raisedByRole: UserRole
  }

  # ==================
  # Input Types - Payments
  # ==================

  input InitializePaymentInput {
    bookingId: ID!
    callbackUrl: String
  }

  input RefundInput {
    paymentId: ID!
    amount: Float
    reason: String!
  }

  input PaymentFiltersInput {
    status: PaymentStatus
    startDate: String
    endDate: String
  }

  # ==================
  # Input Types - Wallet & Withdrawals
  # ==================

  input WalletPaymentInput {
    bookingId: ID!
  }

  input RequestWithdrawalInput {
    amount: Float!
    bankAccountId: ID!
  }

  input AddBankAccountInput {
    bankCode: String!
    accountNumber: String!
  }

  input SetPayoutScheduleInput {
    frequency: PayoutFrequency!
    minimumAmount: Float
  }

  input WalletTransactionFiltersInput {
    type: WalletTransactionType
    source: WalletTransactionSource
    startDate: String
    endDate: String
  }

  input WithdrawalFiltersInput {
    status: WithdrawalStatus
    startDate: String
    endDate: String
  }

  # ==================
  # Input Types - User Management (Admin)
  # ==================

  input BanUserInput {
    userId: ID!
    reason: String!
    durationDays: Int
  }

  input RestrictUserInput {
    userId: ID!
    reason: String!
    durationDays: Int!
  }

  input UserManagementFiltersInput {
    role: UserRole
    accountStatus: AccountStatus
    isBanned: Boolean
    isRestricted: Boolean
    searchTerm: String
    startDate: String
    endDate: String
  }

  input AuditLogFiltersInput {
    action: AdminAction
    adminId: ID
    targetId: ID
    startDate: String
    endDate: String
  }

  # ==================
  # Input Types - Analytics
  # ==================

  enum AnalyticsPeriod {
    DAILY
    WEEKLY
    MONTHLY
    ALL_TIME
  }

  input EarningsReportInput {
    period: AnalyticsPeriod!
    startDate: String
    endDate: String
  }

  input AdminAnalyticsInput {
    period: AnalyticsPeriod!
    startDate: String
    endDate: String
  }

  # ==================
  # Input Types - File Uploads
  # ==================

  input FileUploadInput {
    base64Data: String!
    filename: String!
  }

  # ==================
  # Upload Types
  # ==================

  # Upload result
  type UploadResult {
    url: String!
    publicId: String!
    format: String!
    width: Int
    height: Int
    bytes: Int!
    resourceType: String!
  }

  # Profile photo upload response
  type ProfilePhotoResponse {
    success: Boolean!
    url: String!
    publicId: String!
    message: String!
  }

  # Multiple upload response
  type MultipleUploadResponse {
    success: Boolean!
    urls: [String!]!
    message: String!
  }

  # Signed upload parameters (for client-side uploads)
  type SignedUploadParams {
    signature: String!
    timestamp: Int!
    cloudName: String!
    apiKey: String!
    folder: String!
  }

  # Upload statistics (Admin)
  type UploadStats {
    totalProfiles: Int!
    totalServiceImages: Int!
    totalDocuments: Int!
  }

  # ==================
  # Messaging Types
  # ==================

  # Conversation participant info
  type ConversationParticipant {
    id: ID!
    firstName: String!
    lastName: String!
    profilePhoto: String
    role: UserRole!
    businessName: String
  }

  # Conversation
  type Conversation {
    id: ID!
    type: ConversationType!
    participantIds: [ID!]!
    bookingId: ID
    subject: String
    isActive: Boolean!
    lastMessageAt: String
    lastMessageText: String
    createdAt: String!
    updatedAt: String!
    otherParticipant: ConversationParticipant
    unreadCount: Int
  }

  # Paginated Conversations
  type PaginatedConversations {
    conversations: [Conversation!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Message sender info
  type MessageSender {
    id: ID!
    firstName: String!
    lastName: String!
    profilePhoto: String
    role: UserRole!
    businessName: String
  }

  # Message
  type Message {
    id: ID!
    conversationId: ID!
    senderId: ID!
    senderRole: UserRole!
    content: String!
    attachments: [String!]!
    status: MessageStatus!
    readBy: [ID!]!
    readAt: String
    replyToId: ID
    isDeleted: Boolean!
    createdAt: String!
    updatedAt: String!
    sender: MessageSender
  }

  # Paginated Messages
  type PaginatedMessages {
    messages: [Message!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Unread message count
  type UnreadMessageCount {
    count: Int!
  }

  # ==================
  # Notification Types
  # ==================

  # Notification
  type Notification {
    id: ID!
    userId: ID!
    type: NotificationType!
    title: String!
    message: String!
    entityType: String
    entityId: ID
    metadata: String
    isRead: Boolean!
    readAt: String
    isPushed: Boolean!
    pushedAt: String
    createdAt: String!
  }

  # Paginated Notifications
  type PaginatedNotifications {
    notifications: [Notification!]!
    total: Int!
    page: Int!
    limit: Int!
    totalPages: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  # Unread notification count
  type UnreadNotificationCount {
    count: Int!
  }

  # Notification statistics
  type NotificationStats {
    total: Int!
    unread: Int!
    read: Int!
    byType: String  # JSON string of type counts
  }

  # Push notification registration result
  type PushTokenResult {
    success: Boolean!
    message: String!
    pushEnabled: Boolean!
  }

  # Push status query result
  type PushStatus {
    pushEnabled: Boolean!
    hasDeviceRegistered: Boolean!
    playerId: String
  }

  # ==================
  # Payment Types
  # ==================

  # Payment initialization response
  type PaymentInitializationResponse {
    payment: Payment!
    authorizationUrl: String!
    accessCode: String!
    reference: String!
  }

  # Payment verification response
  type PaymentVerificationResponse {
    payment: Payment!
    verified: Boolean!
    message: String!
  }

  # Payment release response
  type PaymentReleaseResponse {
    success: Boolean!
    message: String!
    payment: Payment
  }

  # Refund response
  type RefundResponse {
    success: Boolean!
    message: String!
    payment: Payment
  }

  # Extended Payment type with more details
  type PaymentDetails {
    id: ID!
    bookingId: ID!
    amount: Float!
    commission: Float!
    providerPayout: Float!
    paystackFee: Float
    status: PaymentStatus!
    paymentMethod: String
    transactionRef: String
    paidAt: String
    refundedAt: String
    payoutAt: String
    refundAmount: Float
    refundReason: String
    createdAt: String!
    updatedAt: String!
    booking: PaymentBookingDetails
  }

  type PaymentBookingDetails {
    id: ID!
    status: BookingStatus!
    scheduledDate: String!
    service: PaymentService
    user: PaymentUser
    provider: PaymentProvider
  }

  type PaymentService {
    id: ID!
    name: String!
    price: Float!
  }

  type PaymentUser {
    id: ID!
    firstName: String!
    lastName: String!
    email: String!
  }

  type PaymentProvider {
    id: ID!
    businessName: String!
    user: PaymentProviderUser
  }

  type PaymentProviderUser {
    id: ID!
    firstName: String!
    lastName: String!
  }

  # Paginated payments
  type PaginatedPayments {
    items: [PaymentDetails!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  # Payment statistics
  type PaymentStats {
    totalPayments: Int!
    completedPayments: Int!
    pendingPayments: Int!
    failedPayments: Int!
    refundedPayments: Int!
    totalRevenue: Float!
    totalCommission: Float!
    totalProviderPayouts: Float!
    commissionRate: Float!
  }

  # Provider earnings summary
  type ProviderEarnings {
    totalEarnings: Float!
    thisMonthEarnings: Float!
    completedJobs: Int!
    commissionRate: Float!
  }

  # Bank information
  type Bank {
    id: Int!
    name: String!
    slug: String!
    code: String!
    longcode: String
    country: String!
    currency: String!
    type: String!
    active: Boolean!
  }

  # Bank account verification response
  type BankAccountVerification {
    accountNumber: String!
    accountName: String!
    bankId: Int
  }

  # Bank suggestion based on account number
  type BankSuggestion {
    possibleBanks: [Bank!]!
    confidence: String!
  }

  # ==================
  # Wallet Types
  # ==================

  # User/Provider wallet
  type Wallet {
    id: ID!
    balance: Float!
    pendingBalance: Float!
    isLocked: Boolean!
    lockReason: String
    createdAt: String!
    updatedAt: String!
  }

  # Wallet transaction
  type WalletTransaction {
    id: ID!
    type: WalletTransactionType!
    source: WalletTransactionSource!
    amount: Float!
    balanceAfter: Float!
    description: String
    referenceId: String
    createdAt: String!
  }

  # Paginated wallet transactions
  type PaginatedWalletTransactions {
    items: [WalletTransaction!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  # Wallet payment result
  type WalletPaymentResult {
    success: Boolean!
    message: String!
    remainingBalance: Float!
    transaction: WalletTransaction
  }

  # ==================
  # Provider Bank Account Types
  # ==================

  type ProviderBankAccount {
    id: ID!
    bankCode: String!
    bankName: String!
    accountNumber: String!
    accountName: String!
    isDefault: Boolean!
    isVerified: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  # ==================
  # Withdrawal Types
  # ==================

  type Withdrawal {
    id: ID!
    amount: Float!
    fee: Float!
    netAmount: Float!
    status: WithdrawalStatus!
    bankAccountSnapshot: BankAccountSnapshot!
    transferCode: String
    transferRef: String
    failureReason: String
    retryCount: Int!
    processedAt: String
    createdAt: String!
    updatedAt: String!
  }

  type BankAccountSnapshot {
    bankCode: String!
    bankName: String!
    accountNumber: String!
    accountName: String!
  }

  type PaginatedWithdrawals {
    items: [Withdrawal!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  type WithdrawalResult {
    success: Boolean!
    message: String!
    withdrawal: Withdrawal
  }

  # ==================
  # Payout Schedule Types
  # ==================

  type PayoutSchedule {
    id: ID!
    frequency: PayoutFrequency!
    minimumAmount: Float!
    nextPayoutDate: String
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type ScheduledPayout {
    id: ID!
    amount: Float!
    fee: Float!
    netAmount: Float!
    status: WithdrawalStatus!
    scheduledFor: String!
    processedAt: String
    failureReason: String
    createdAt: String!
  }

  type PaginatedScheduledPayouts {
    items: [ScheduledPayout!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  type PendingEarnings {
    totalPending: Float!
    availableNow: Float!
    pendingClearance: Float!
    nextAvailableDate: String
  }

  # ==================
  # Payment Analytics Types
  # ==================

  type ProviderEarningsReport {
    period: String!
    startDate: String!
    endDate: String!
    totalEarnings: Float!
    completedJobs: Int!
    commissionPaid: Float!
    netEarnings: Float!
    withdrawnAmount: Float!
    pendingBalance: Float!
    breakdown: [EarningsBreakdownItem!]!
  }

  type EarningsBreakdownItem {
    date: String!
    earnings: Float!
    jobs: Int!
  }

  type AdminPaymentAnalytics {
    period: String!
    totalTransactions: Int!
    totalVolume: Float!
    totalCommission: Float!
    totalRefunds: Float!
    netRevenue: Float!
    averageTransactionValue: Float!
    transactionsByStatus: TransactionStatusBreakdown!
  }

  type TransactionStatusBreakdown {
    completed: Int!
    pending: Int!
    failed: Int!
    refunded: Int!
  }

  type TopEarningProvider {
    providerId: ID!
    businessName: String!
    totalEarnings: Float!
    completedJobs: Int!
  }

  type RefundStats {
    totalRefunds: Int!
    totalRefundAmount: Float!
    refundRate: Float!
    averageRefundAmount: Float!
    refundsByReason: [RefundReasonBreakdown!]!
  }

  type RefundReasonBreakdown {
    reason: String!
    count: Int!
    amount: Float!
  }

  # ==================
  # User Management Types (Admin)
  # ==================

  type ManagedUser {
    id: ID!
    email: String!
    firstName: String!
    lastName: String!
    phone: String
    role: UserRole!
    accountStatus: AccountStatus!
    isBanned: Boolean!
    bannedAt: String
    bannedUntil: String
    bannedReason: String
    isRestricted: Boolean!
    restrictedAt: String
    restrictedUntil: String
    restrictionReason: String
    createdAt: String!
    lastLoginAt: String
    provider: ManagedProvider
  }

  type ManagedProvider {
    id: ID!
    businessName: String!
    verificationStatus: VerificationStatus!
    averageRating: Float
    totalReviews: Int
    totalServices: Int
    totalBookings: Int
    totalEarnings: Float
  }

  type PaginatedManagedUsers {
    items: [ManagedUser!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  type UserManagementResult {
    success: Boolean!
    message: String!
    user: ManagedUser
  }

  # Admin audit log
  type AdminAuditLog {
    id: ID!
    adminId: ID!
    adminEmail: String!
    action: AdminAction!
    targetType: String!
    targetId: ID!
    reason: String
    metadata: String
    ipAddress: String
    userAgent: String
    createdAt: String!
  }

  type PaginatedAuditLogs {
    items: [AdminAuditLog!]!
    total: Int!
    page: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  # ==================
  # Settings Types
  # ==================

  type UserSettings {
    id: ID!
    # In-app / push notification toggles
    notifyBookingUpdates: Boolean!
    notifyMessages: Boolean!
    notifyReviews: Boolean!
    notifyPromotions: Boolean!
    notifyDisputeUpdates: Boolean!
    notifyProviderVerification: Boolean!
    # Email notification toggles
    emailBookingUpdates: Boolean!
    emailMessages: Boolean!
    emailReviews: Boolean!
    emailPromotions: Boolean!
    emailNewsletters: Boolean!
    # Locale & display
    language: String!
    timezone: String!
    currency: String!
    # Privacy
    showProfileToPublic: Boolean!
    showPhoneToProviders: Boolean!
    updatedAt: String!
  }

  type UpdateSettingsResponse {
    success: Boolean!
    message: String!
    settings: UserSettings!
  }

  # ==================
  # Input Types - Messaging
  # ==================

  input StartConversationInput {
    participantId: ID!
    subject: String
    bookingId: ID
    initialMessage: String
  }

  input SendMessageInput {
    conversationId: ID!
    content: String!
    attachments: [String!]
    replyToId: ID
  }

  input StartSupportChatInput {
    subject: String!
    initialMessage: String!
  }

  # ==================
  # Input Types - Notifications
  # ==================

  input NotificationFiltersInput {
    type: NotificationType
    isRead: Boolean
  }

  input SendAnnouncementInput {
    title: String!
    message: String!
    targetRoles: [UserRole!]
  }

  # ==================
  # Input Types - Settings
  # ==================

  input UpdateSettingsInput {
    # In-app / push notification preferences
    notifyBookingUpdates: Boolean
    notifyMessages: Boolean
    notifyReviews: Boolean
    notifyPromotions: Boolean
    notifyDisputeUpdates: Boolean
    notifyProviderVerification: Boolean
    # Email notification preferences
    emailBookingUpdates: Boolean
    emailMessages: Boolean
    emailReviews: Boolean
    emailPromotions: Boolean
    emailNewsletters: Boolean
    # Locale & display
    language: String
    timezone: String
    currency: String
    # Privacy
    showProfileToPublic: Boolean
    showPhoneToProviders: Boolean
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
    phone: String
    profilePhoto: String
  }

  input AdminRequestEmailChangeInput {
    newEmail: String!
  }

  input AdminConfirmEmailChangeInput {
    otp: String!
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
    
    # Get provider verification status
    myVerificationStatus: VerificationStatusResponse!

    # Get own provider profile (for SERVICE_PROVIDER role) - includes full services list
    myProviderProfile: User!

    # Get current active role status (for role switching)
    myActiveRole: ActiveRoleStatus!

    # ==================
    # Review Queries
    # ==================

    # Get review by ID
    review(id: ID!): Review

    # Get reviews for a provider
    providerReviews(providerId: ID!, filters: ReviewFiltersInput, pagination: PaginationInput): PaginatedReviews!

    # Get reviews for a service
    serviceReviews(serviceId: ID!, pagination: PaginationInput): PaginatedReviews!

    # Get my reviews (reviews I've written)
    myReviews(pagination: PaginationInput): PaginatedReviews!

    # Get provider's rating statistics
    providerRating(providerId: ID!): ProviderRatingStats!

    # Check if user can review a booking
    canReviewBooking(bookingId: ID!): CanReviewResponse!

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

    # ==================
    # Booking Queries
    # ==================
    
    # Get booking by ID
    booking(id: ID!): Booking
    
    # Get user's bookings (as customer)
    myBookings(filters: BookingFiltersInput, pagination: PaginationInput): PaginatedBookings!
    
    # Get provider's bookings
    providerBookings(filters: BookingFiltersInput, pagination: PaginationInput): PaginatedBookings!
    
    # Get user's booking statistics
    myBookingStats: BookingStats!
    
    # Get provider's booking statistics
    providerBookingStats: BookingStats!
    
    # Get all bookings (Admin only)
    allBookings(filters: BookingFiltersInput, pagination: PaginationInput): PaginatedBookings!

    # ==================
    # Favourite Queries
    # ==================
    
    # Get user's favourites
    myFavourites(pagination: PaginationInput): PaginatedFavourites!
    
    # Get a specific favourite by ID
    favourite(id: ID!): Favourite
    
    # Check if a service is favourited
    isFavourited(serviceId: ID!): IsFavouritedResponse!
    
    # Get favourite count for a service (public - useful for popularity)
    serviceFavouriteCount(serviceId: ID!): ServiceFavouriteCountResponse!

    # ==================
    # Provider Like Queries
    # ==================
    
    # Check if user has liked a provider
    isProviderLiked(providerId: ID!): IsProviderLikedResponse!
    
    # Get user's liked providers
    myLikedProviders(pagination: PaginationInput): PaginatedLikedProviders!
    
    # Get like count for a provider (public)
    providerLikeCount(providerId: ID!): Int!

    # ==================
    # Browse / Discovery Queries (Public)
    # ==================

    # Browse all verified providers with optional filters and sorting
    providers(input: BrowseProvidersInput): PaginatedBrowseProviders!

    # Get a single provider's full public profile
    providerProfile(providerId: ID!): PublicProviderProfile!

    # Get nearby providers within a radius using geolocation
    nearbyProviders(input: NearbyProvidersInput!): PaginatedNearbyProviders!

    # ==================
    # Dispute Queries
    # ==================
    
    # Get dispute by ID
    dispute(id: ID!): Dispute
    
    # Get dispute for a booking
    bookingDispute(bookingId: ID!): Dispute
    
    # Get user's disputes (as user or provider)
    myDisputes(filters: DisputeFiltersInput, pagination: PaginationInput): PaginatedDisputes!
    
    # Get all disputes (Admin only)
    allDisputes(filters: DisputeFiltersInput, pagination: PaginationInput): PaginatedDisputes!
    
    # Get open disputes count (Admin dashboard)
    openDisputesCount: OpenDisputesCountResponse!
    
    # Get dispute statistics (Admin dashboard)
    disputeStats: DisputeStats!

    # ==================
    # Upload Queries
    # ==================
    
    # Get signed upload parameters for client-side upload (Profile)
    getProfileUploadParams: SignedUploadParams!
    
    # Get signed upload parameters for client-side upload (Service images)
    getServiceUploadParams: SignedUploadParams!
    
    # Get signed upload parameters for client-side upload (Documents)
    getDocumentUploadParams: SignedUploadParams!
    
    # Get signed upload parameters for client-side upload (Evidence)
    getEvidenceUploadParams: SignedUploadParams!
    
    # Get upload statistics (Admin)
    uploadStats: UploadStats!

    # ==================
    # Messaging Queries
    # ==================

    # Get user's conversations
    myConversations(pagination: PaginationInput): PaginatedConversations!

    # Get conversation by ID
    conversation(id: ID!): Conversation

    # Get messages in a conversation
    conversationMessages(conversationId: ID!, pagination: PaginationInput): PaginatedMessages!

    # Get unread message count
    unreadMessageCount: UnreadMessageCount!

    # Get booking conversation (creates if doesn't exist)
    bookingConversation(bookingId: ID!): Conversation

    # ==================
    # Notification Queries
    # ==================

    # Get user's notifications
    myNotifications(filters: NotificationFiltersInput, pagination: PaginationInput): PaginatedNotifications!

    # Get notification by ID
    notification(id: ID!): Notification

    # Get unread notification count
    unreadNotificationCount: UnreadNotificationCount!

    # Get notification statistics
    notificationStats: NotificationStats!

    # ==================
    # Push Notification Queries
    # ==================

    # Get current push notification status for the authenticated user
    myPushStatus: PushStatus!

    # ==================
    # Settings Queries
    # ==================

    # Get the authenticated user's account settings
    mySettings: UserSettings!

    # ==================
    # Payment Queries
    # ==================

    # Get payment by ID
    payment(id: ID!): PaymentDetails

    # Get payment by booking ID
    paymentByBooking(bookingId: ID!): PaymentDetails

    # Get user's payment history
    myPayments(filters: PaymentFiltersInput, pagination: PaginationInput): PaginatedPayments!

    # Get provider's payment/earnings history
    providerPayments(filters: PaymentFiltersInput, pagination: PaginationInput): PaginatedPayments!

    # Get provider's earnings summary
    myEarnings: ProviderEarnings!

    # Get all payments (Admin)
    allPayments(filters: PaymentFiltersInput, pagination: PaginationInput): PaginatedPayments!

    # Get payment statistics (Admin)
    paymentStats: PaymentStats!

    # List available banks for payout
    banks: [Bank!]!

    # Verify bank account details
    verifyBankAccount(accountNumber: String!, bankCode: String!): BankAccountVerification!

    # Suggest banks based on account number prefix
    suggestBankFromAccountNumber(accountNumber: String!): BankSuggestion!

    # ==================
    # Wallet Queries
    # ==================

    # Get my wallet (User or Provider)
    myWallet: Wallet!

    # Get wallet transaction history
    myWalletTransactions(filters: WalletTransactionFiltersInput, pagination: PaginationInput): PaginatedWalletTransactions!

    # ==================
    # Bank Account Queries (Provider)
    # ==================

    # Get my bank accounts
    myBankAccounts: [ProviderBankAccount!]!

    # Get a specific bank account
    bankAccount(id: ID!): ProviderBankAccount

    # ==================
    # Withdrawal Queries (Provider)
    # ==================

    # Get my withdrawals
    myWithdrawals(filters: WithdrawalFiltersInput, pagination: PaginationInput): PaginatedWithdrawals!

    # Get a specific withdrawal
    withdrawal(id: ID!): Withdrawal

    # ==================
    # Payout Schedule Queries (Provider)
    # ==================

    # Get my payout schedule
    myPayoutSchedule: PayoutSchedule

    # Get pending earnings
    myPendingEarnings: PendingEarnings!

    # Get scheduled payouts
    myScheduledPayouts(pagination: PaginationInput): PaginatedScheduledPayouts!

    # ==================
    # Payment Analytics Queries
    # ==================

    # Get provider earnings report (Provider)
    myEarningsReport(input: EarningsReportInput!): ProviderEarningsReport!

    # Get admin payment analytics (Admin)
    adminPaymentAnalytics(input: AdminAnalyticsInput!): AdminPaymentAnalytics!

    # Get top earning providers (Admin)
    topEarningProviders(limit: Int, period: AnalyticsPeriod): [TopEarningProvider!]!

    # Get refund statistics (Admin)
    refundStats(period: AnalyticsPeriod): RefundStats!

    # ==================
    # User Management Queries (Admin)
    # ==================

    # Get all managed users with filters
    managedUsers(filters: UserManagementFiltersInput, pagination: PaginationInput): PaginatedManagedUsers!

    # Get managed user details
    managedUser(id: ID!): ManagedUser

    # Get all managed providers with filters
    managedProviders(filters: UserManagementFiltersInput, pagination: PaginationInput): PaginatedManagedUsers!

    # Get admin audit logs
    auditLogs(filters: AuditLogFiltersInput, pagination: PaginationInput): PaginatedAuditLogs!

    # Get audit logs for a specific target
    auditLogsForTarget(targetId: ID!, pagination: PaginationInput): PaginatedAuditLogs!

    # Get all pending withdrawals (Admin)
    pendingWithdrawals(pagination: PaginationInput): PaginatedWithdrawals!

    # Get all withdrawals (Admin)
    allWithdrawals(filters: WithdrawalFiltersInput, pagination: PaginationInput): PaginatedWithdrawals!
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
    logout(refreshToken: String): MessageResponse!

    # ==================
    # User Profile (Unified)
    # ==================
    
    # Update user profile
    updateProfile(input: UpdateProfileInput!): User!
    requestEmailChange(input: RequestEmailChangeInput!): MessageResponse!
    confirmEmailChange(input: ConfirmEmailChangeInput!): User!
    
    # Delete own account
    deleteAccount: MessageResponse!

    # ==================
    # Service Provider (Upgrade & Management)
    # ==================
    
    # Upgrade from SERVICE_USER to SERVICE_PROVIDER
    becomeProvider(input: BecomeProviderInput!): BecomeProviderResponse!
    
    # Update provider profile
    updateProviderProfile(input: UpdateProviderProfileInput!): User!
    
    # Submit provider profile for verification (can re-submit after rejection)
    submitProviderForVerification: User!

    # Switch between SERVICE_USER and SERVICE_PROVIDER mode (only for registered providers)
    switchActiveRole(targetRole: UserRole!): User!

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
    # Booking Management (User)
    # ==================
    
    # Create a new booking (USER only)
    createBooking(input: CreateBookingInput!): Booking!
    
    # Update a pending booking (USER only)
    updateBooking(id: ID!, input: UpdateBookingInput!): Booking!
    
    # Cancel a booking (USER only)
    cancelBooking(id: ID!, reason: String!): Booking!

    # ==================
    # Booking Management (Provider)
    # ==================
    
    # Accept a booking (PROVIDER only)
    acceptBooking(id: ID!): Booking!
    
    # Reject a booking (PROVIDER only)
    rejectBooking(id: ID!, reason: String!): Booking!
    
    # Start service - marks booking as IN_PROGRESS (PROVIDER only)
    startService(id: ID!): Booking!
    
    # Complete service - marks booking as COMPLETED (PROVIDER only)
    completeService(id: ID!): Booking!

    # ==================
    # Booking Management (Admin)
    # ==================
    
    # Admin cancel any booking
    adminCancelBooking(id: ID!, reason: String!): Booking!

    # ==================
    # Payment Mutations
    # ==================

    # Initialize payment for a booking (User)
    initializePayment(input: InitializePaymentInput!): PaymentInitializationResponse!

    # Verify payment status (User)
    verifyPayment(transactionRef: String!): PaymentVerificationResponse!

    # Process refund (Admin)
    processRefund(input: RefundInput!): RefundResponse!

    # ==================
    # Wallet Mutations
    # ==================

    # Pay for a booking using wallet balance (User)
    payWithWallet(input: WalletPaymentInput!): WalletPaymentResult!

    # ==================
    # Bank Account Mutations (Provider)
    # ==================

    # Add a bank account
    addBankAccount(input: AddBankAccountInput!): ProviderBankAccount!

    # Set default bank account
    setDefaultBankAccount(id: ID!): ProviderBankAccount!

    # Remove a bank account
    removeBankAccount(id: ID!): MessageResponse!

    # ==================
    # Withdrawal Mutations (Provider)
    # ==================

    # Request a withdrawal
    requestWithdrawal(input: RequestWithdrawalInput!): WithdrawalResult!

    # Cancel a pending withdrawal
    cancelWithdrawal(id: ID!): MessageResponse!

    # ==================
    # Payout Schedule Mutations (Provider)
    # ==================

    # Set payout schedule
    setPayoutSchedule(input: SetPayoutScheduleInput!): PayoutSchedule!

    # Disable scheduled payouts
    disablePayoutSchedule: MessageResponse!

    # ==================
    # Withdrawal Mutations (Admin)
    # ==================

    # Process a pending withdrawal (Admin)
    processWithdrawal(id: ID!): WithdrawalResult!

    # Reject a withdrawal (Admin)
    rejectWithdrawal(id: ID!, reason: String!): WithdrawalResult!

    # Retry a failed withdrawal (Admin)
    retryWithdrawal(id: ID!): WithdrawalResult!

    # ==================
    # User Management Mutations (Admin)
    # ==================

    # Ban a user/provider
    banUser(input: BanUserInput!): UserManagementResult!

    # Unban a user/provider
    unbanUser(userId: ID!): UserManagementResult!

    # Restrict a user/provider for specific days
    restrictUser(input: RestrictUserInput!): UserManagementResult!

    # Remove restriction from user/provider
    removeRestriction(userId: ID!): UserManagementResult!

    # Adjust wallet balance (Admin)
    adjustWalletBalance(userId: ID!, amount: Float!, reason: String!): Wallet!

    # ==================
    # Review Management
    # ==================

    # Create a review for a completed booking (User)
    createReview(input: CreateReviewInput!): Review!

    # Update own review within 24 hours (User)
    updateReview(id: ID!, input: UpdateReviewInput!): Review!

    # Respond to a review (Provider)
    respondToReview(reviewId: ID!, response: String!): Review!

    # Delete a review (Admin)
    deleteReview(id: ID!): MessageResponse!

    # ==================
    # Favourite Management (User)
    # ==================

    # Add a service to favourites
    addFavourite(serviceId: ID!): Favourite!

    # Remove a service from favourites
    removeFavourite(serviceId: ID!): MessageResponse!

    # Toggle favourite status (add if not favourited, remove if favourited)
    toggleFavourite(serviceId: ID!): ToggleFavouriteResponse!

    # ==================
    # Provider Like Mutations
    # ==================
    
    # Like a service provider
    likeProvider(providerId: ID!): ProviderLikeResponse!
    
    # Unlike a service provider
    unlikeProvider(providerId: ID!): ProviderLikeResponse!
    
    # Toggle like status on a provider
    toggleProviderLike(providerId: ID!): ToggleProviderLikeResponse!

    # ==================
    # Dispute Management (User/Provider)
    # ==================

    # Create a dispute for a booking (User or Provider)
    createDispute(input: CreateDisputeInput!): Dispute!

    # Add evidence to an open dispute
    addDisputeEvidence(disputeId: ID!, evidence: [String!]!): Dispute!

    # ==================
    # Dispute Management (Admin)
    # ==================

    # Take dispute under review
    takeDisputeUnderReview(disputeId: ID!): Dispute!

    # Resolve a dispute
    resolveDispute(disputeId: ID!, input: ResolveDisputeInput!): Dispute!

    # Close a dispute without resolution (for invalid disputes)
    closeDispute(disputeId: ID!, reason: String!): Dispute!

    # ==================
    # File Upload Management (User)
    # ==================

    # Upload profile photo
    uploadProfilePhoto(file: FileUploadInput!): ProfilePhotoResponse!

    # Remove profile photo
    removeProfilePhoto: MessageResponse!

    # ==================
    # File Upload Management (Provider)
    # ==================

    # Upload provider gallery images
    uploadProviderImages(files: [FileUploadInput!]!): MultipleUploadResponse!

    # Remove a provider gallery image
    removeProviderImage(imageUrl: String!): MessageResponse!

    # Upload service images
    uploadServiceImages(serviceId: ID!, files: [FileUploadInput!]!): MultipleUploadResponse!

    # Remove service image
    removeServiceImage(serviceId: ID!, imageUrl: String!): MessageResponse!

    # Upload provider documents
    uploadProviderDocuments(files: [FileUploadInput!]!): MultipleUploadResponse!

    # Remove provider document
    removeProviderDocument(documentUrl: String!): MessageResponse!

    # ==================
    # Messaging Mutations
    # ==================

    # Start a new conversation or get existing
    startConversation(input: StartConversationInput!): Conversation!

    # Send a message
    sendMessage(input: SendMessageInput!): Message!

    # Mark messages as read
    markMessagesAsRead(conversationId: ID!, messageIds: [ID!]): MessageResponse!

    # Archive a conversation
    archiveConversation(conversationId: ID!): MessageResponse!

    # Delete a message (soft delete, own messages only)
    deleteMessage(messageId: ID!): MessageResponse!

    # Start a support chat with admin
    startSupportChat(input: StartSupportChatInput!): Conversation!

    # ==================
    # Notification Mutations
    # ==================

    # Mark notification as read
    markNotificationAsRead(notificationId: ID!): Notification!

    # Mark all notifications as read
    markAllNotificationsAsRead: MessageResponse!

    # Delete a notification
    deleteNotification(notificationId: ID!): MessageResponse!

    # Delete all read notifications
    deleteReadNotifications: MessageResponse!

    # Send system announcement (Admin only)
    sendSystemAnnouncement(input: SendAnnouncementInput!): MessageResponse!

    # ==================
    # Push Notification Mutations
    # ==================

    # Register device for push notifications (OneSignal Player ID)
    registerPushToken(playerId: String!): PushTokenResult!

    # Unregister device from push notifications
    unregisterPushToken: PushTokenResult!

    # Update push notification preference
    updatePushPreference(enabled: Boolean!): PushTokenResult!

    # Enable push notifications on a specific device (convenience wrapper)
    enablePushNotifications(playerId: String!): PushTokenResult!

    # Disable push notifications and remove device token
    disablePushNotifications: PushTokenResult!

    # Toggle push on/off without changing the registered device
    togglePushNotifications(enabled: Boolean!): PushTokenResult!

    # ==================
    # Settings Mutations
    # ==================

    # Update account settings (notification prefs, locale, privacy)
    updateMySettings(input: UpdateSettingsInput!): UpdateSettingsResponse!

    # Reset all settings back to defaults
    resetMySettings: UpdateSettingsResponse!

    # Deactivate own account (soft-disable — keeps data, blocks login)
    deactivateMyAccount(reason: String): MessageResponse!

    # Reactivate a previously deactivated account
    reactivateMyAccount: MessageResponse!

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
    
    # Admin logout (invalidate refresh token)
    adminLogout(refreshToken: String): MessageResponse!

    # ==================
    # Admin Profile Management
    # ==================
    
    # Update own admin profile
    updateAdminProfile(input: UpdateAdminInput!): AdminUser!
    adminRequestEmailChange(input: AdminRequestEmailChangeInput!): MessageResponse!
    adminConfirmEmailChange(input: AdminConfirmEmailChangeInput!): AdminUser!

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
