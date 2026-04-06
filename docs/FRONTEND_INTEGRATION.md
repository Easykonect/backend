# EasyKonnect GraphQL API - Frontend Integration Guide

## Overview

This API uses **GraphQL** over HTTP POST requests. All requests go to a single endpoint:

- **Development**: `http://localhost:3000/api/graphql`
- **Production**: `https://backend-ehtm.onrender.com/api/graphql`
- **API Documentation**: `https://backend-ehtm.onrender.com/docs`

## Platform Support

| Platform | Libraries |
|----------|-----------|
| **React/Next.js** | Apollo Client, urql, graphql-request |
| **React Native** | Apollo Client, urql |
| **Flutter** | graphql_flutter, ferry |
| **iOS (Swift)** | Apollo iOS |
| **Android (Kotlin)** | Apollo Kotlin |
| **Vue.js** | Vue Apollo |

---

## API Features (v2.2.0)

### ✅ Implemented Features

| Feature | Status | Description |
|---------|--------|-------------|
| **Authentication** | ✅ Complete | Register, Login, Email Verification, Password Reset |
| **User Management** | ✅ Complete | Profile CRUD, Photo Upload, Role Management |
| **Provider System** | ✅ Complete | Become Provider, Verification Workflow |
| **Services** | ✅ Complete | CRUD, Categories, Search, Filtering |
| **Bookings** | ✅ Complete | Create, Accept/Reject, Complete, Cancel |
| **Reviews** | ✅ Complete | Create, Respond, Rating Stats |
| **Favourites** | ✅ Complete | Add/Remove, List |
| **Disputes** | ✅ Complete | Raise, Evidence Upload, Resolution |
| **Messaging** | ✅ Complete | Real-time via WebSocket |
| **Notifications** | ✅ Complete | In-app + Real-time Push |
| **Admin Panel** | ✅ Complete | User/Provider/Service Management |
| **Rate Limiting** | ✅ Complete | Per-user/IP limits |
| **Security** | ✅ Complete | JWT, OTP hashing, Account Lockout |
| **Push Notifications** | ✅ Complete | OneSignal integration (iOS + Android) |
| **Provider Gallery Images** | ✅ Complete | Upload/Remove provider portfolio images |
| **Provider Documents** | ✅ Complete | Upload/Remove verification documents |
| **Provider Likes** | ✅ Complete | Like/Unlike/Toggle, like count, liked list |
| **Geolocation/Maps** | ✅ Complete | Nearby providers, distance calculation, Places autocomplete |

### 🔜 Coming Soon

| Feature | Status |
|---------|--------|
| Payment Integration (Paystack) | ✅ Complete |
| Wallet System | ✅ Complete |
| Bank Account Management | ✅ Complete |
| Withdrawal System | ✅ Complete |
| Scheduled Payouts | ✅ Complete |

---

## Security & Rate Limits

### Rate Limits

| Operation | Limit | Window | Block Duration |
|-----------|-------|--------|----------------|
| Login | 5 attempts | 5 minutes | 15 minutes |
| Registration | 5 attempts | 1 hour | 1 hour |
| OTP Verification | 5 attempts | 5 minutes | 10 minutes |
| OTP Resend | 3 attempts | 5 minutes | 10 minutes |
| Password Reset | 3 attempts | 1 hour | 1 hour |
| File Uploads | 20 uploads | 1 minute | - |
| Messaging | 60 messages | 1 minute | - |
| Bank Operations | 5 requests | 5 seconds | - |
| General API | 100 requests | 15 minutes | - |

### Security Features

- 🔒 **Password Hashing**: bcrypt with 12 salt rounds
- 🔒 **OTP Security**: SHA-256 hashing with timing-safe comparison
- 🔒 **JWT Tokens**: Access (7d) + Refresh (30d) with blacklisting
- 🔒 **Token Invalidation**: All tokens invalidated on password change/reset
- 🔒 **Account Lockout**: 5 failed login attempts = 15-minute lockout
- 🔒 **XSS Prevention**: All user inputs sanitized before storage
- 🔒 **NoSQL Injection Protection**: Search queries sanitized against injection
- 🔒 **IDOR Protection**: Users can only access their own resources
- 🔒 **Query Depth Limit**: Maximum 10 levels (prevents DoS)
- 🔒 **Request Size Limit**: 1MB maximum body size
- 🔒 **Webhook Security**: Signature verification + IP whitelisting
- 🔒 **Distributed Locking**: Redis locks for wallet operations
- 🔒 **Introspection**: Disabled in production

### Token Invalidation Behavior

When a user changes or resets their password:
1. All existing tokens (access + refresh) are immediately invalidated
2. User must re-login on ALL devices
3. API calls with old tokens return `UNAUTHENTICATED` error

**Frontend handling:**
```javascript
// Handle token invalidation in your GraphQL client
if (error.extensions?.code === 'UNAUTHENTICATED') {
  // Clear stored tokens
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  // Redirect to login
  router.push('/login');
}
```

---

## Quick Start

### Basic Request Format

All GraphQL requests are HTTP POST with JSON body:

```javascript
// Using fetch
const response = await fetch('https://backend-ehtm.onrender.com/api/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_ACCESS_TOKEN', // For authenticated requests
  },
  body: JSON.stringify({
    query: `mutation { ... }`,
    variables: { ... }
  }),
});

const data = await response.json();
```

---

# Authentication APIs

These APIs handle user registration, login, password management, and session management. No authentication token is required for these endpoints (except logout and changePassword).

---

## 1. Register User

**What this API does:** This API is used for creating a new SERVICE_USER account on the EasyKonnect platform. When called, it validates the user's information, creates the account with PENDING status, and sends a 6-digit OTP to the user's email address for verification. The user cannot log in until they verify their email using the verifyEmail API.

**What it returns:** Returns a `RegistrationResponse` containing a success boolean, a message confirming the account was created, and a `requiresVerification` flag set to true indicating the user must verify their email before logging in.

### Request

```graphql
mutation Register($input: RegisterUserInput!) {
  register(input: $input) {
    success
    message
    requiresVerification
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com",
    "password": "SecurePass123!",
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+2348012345678"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "register": {
      "success": true,
      "message": "Registration successful! Please check your email for the verification code.",
      "requiresVerification": true
    }
  }
}
```

### Error Responses

**User Already Exists (Email taken)**
```json
{
  "errors": [
    {
      "message": "A user with this email already exists",
      "extensions": {
        "code": "USER_ALREADY_EXISTS"
      }
    }
  ],
  "data": null
}
```

**Validation Error (Invalid password)**
```json
{
  "errors": [
    {
      "message": "Password must contain at least one special character (!@#$%^&*()_+-=[]{};\\':\"|,.<>/?)",
      "extensions": {
        "code": "VALIDATION_ERROR"
      }
    }
  ],
  "data": null
}
```

**Validation Error (Invalid email)**
```json
{
  "errors": [
    {
      "message": "Invalid email address",
      "extensions": {
        "code": "VALIDATION_ERROR"
      }
    }
  ],
  "data": null
}
```

### Password Requirements

- Minimum 8 characters
- Maximum 128 characters
- At least one uppercase letter (A-Z)
- At least one lowercase letter (a-z)
- At least one number (0-9)
- At least one special character (!@#$%^&*()_+-=[]{};\\':\"|,.<>/?)

---

## 2. Verify Email

**What this API does:** This API is used for verifying a user's email address after registration. It validates the 6-digit OTP that was sent to the user's email during registration. Upon successful verification, it changes the user's status from PENDING to ACTIVE, sets `isEmailVerified` to true, and automatically logs the user in by generating JWT tokens.

**What it returns:** Returns a `VerifyEmailResponse` containing a success boolean, a confirmation message, the complete user object (id, email, firstName, lastName, role, status, isEmailVerified), and both `accessToken` and `refreshToken` for automatic login - no separate login call is needed after verification.

### Request

```graphql
mutation VerifyEmail($input: VerifyEmailInput!) {
  verifyEmail(input: $input) {
    success
    message
    user {
      id
      email
      firstName
      lastName
      role
      status
      isEmailVerified
    }
    accessToken
    refreshToken
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com",
    "otp": "123456"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "verifyEmail": {
      "success": true,
      "message": "Email verified successfully!",
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "user@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_USER",
        "status": "ACTIVE",
        "isEmailVerified": true
      },
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
}
```

### Error Responses

**Invalid OTP**
```json
{
  "errors": [
    {
      "message": "Invalid verification code. Please try again.",
      "extensions": {
        "code": "INVALID_OTP"
      }
    }
  ],
  "data": null
}
```

**OTP Expired**
```json
{
  "errors": [
    {
      "message": "Verification code has expired. Please request a new one.",
      "extensions": {
        "code": "OTP_EXPIRED"
      }
    }
  ],
  "data": null
}
```

**User Not Found**
```json
{
  "errors": [
    {
      "message": "User not found",
      "extensions": {
        "code": "USER_NOT_FOUND"
      }
    }
  ],
  "data": null
}
```

**Already Verified**
```json
{
  "errors": [
    {
      "message": "Email is already verified",
      "extensions": {
        "code": "ALREADY_VERIFIED"
      }
    }
  ],
  "data": null
}
```

---

## 3. Resend Verification OTP

**What this API does:** This API is used for requesting a new verification OTP when the original one has expired (after 10 minutes) or wasn't received. It invalidates any existing OTP for the email address, generates a new 6-digit OTP, and sends it to the user's email. This endpoint is rate-limited to prevent abuse.

**What it returns:** Returns a `MessageResponse` containing a success boolean and a message confirming that a new verification code has been sent to the email address.

### Request

```graphql
mutation ResendOtp($input: ResendOtpInput!) {
  resendVerificationOtp(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "resendVerificationOtp": {
      "success": true,
      "message": "A new verification code has been sent to your email."
    }
  }
}
```

### Error Response

**Already Verified**
```json
{
  "errors": [
    {
      "message": "Email is already verified. Please login.",
      "extensions": {
        "code": "ALREADY_VERIFIED"
      }
    }
  ],
  "data": null
}
```

---

## 4. Login

**What this API does:** This API is used for authenticating a user with their email and password credentials. It validates the credentials, checks that the account is ACTIVE and email is verified, updates the `lastLoginAt` timestamp, and generates JWT tokens. Works for both SERVICE_USER and SERVICE_PROVIDER accounts. The account will be locked after 5 failed login attempts.

**What it returns:** Returns an `AuthResponse` containing the complete user object (id, email, firstName, lastName, phone, role, status), an `accessToken` (expires in 15 minutes) for API authorization, and a `refreshToken` (expires in 30 days) for obtaining new access tokens.

### Request

```graphql
mutation Login($input: LoginInput!) {
  login(input: $input) {
    user {
      id
      email
      firstName
      lastName
      phone
      role
      status
    }
    accessToken
    refreshToken
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com",
    "password": "SecurePass123!"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "login": {
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "user@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "phone": "+2348012345678",
        "role": "SERVICE_USER",
        "status": "ACTIVE"
      },
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
}
```

### Error Responses

**Invalid Credentials**
```json
{
  "errors": [
    {
      "message": "Invalid email or password",
      "extensions": {
        "code": "INVALID_CREDENTIALS",
        "attemptsRemaining": 4
      }
    }
  ],
  "data": null
}
```

**Email Not Verified**
```json
{
  "errors": [
    {
      "message": "Please verify your email before logging in. Check your inbox for the verification code.",
      "extensions": {
        "code": "EMAIL_NOT_VERIFIED",
        "requiresVerification": true
      }
    }
  ],
  "data": null
}
```

**Account Locked**
```json
{
  "errors": [
    {
      "message": "Account is locked due to too many failed attempts. Please try again in 28 minutes.",
      "extensions": {
        "code": "ACCOUNT_LOCKED"
      }
    }
  ],
  "data": null
}
```

**Account Suspended**
```json
{
  "errors": [
    {
      "message": "Your account has been suspended. Please contact support.",
      "extensions": {
        "code": "USER_SUSPENDED"
      }
    }
  ],
  "data": null
}
```

---

## 5. Refresh Token

**What this API does:** This API is used for obtaining a new access token when the current one has expired. It validates the refresh token, verifies the user account is still active, and generates a new access token. This enables seamless user experience without requiring re-login every 15 minutes.

**What it returns:** Returns a `RefreshTokenResponse` containing a new `accessToken` and the current user object (id, email, firstName, lastName, role, status). The original refresh token remains valid until its 30-day expiration.

### Request

```graphql
mutation RefreshToken($refreshToken: String!) {
  refreshToken(refreshToken: $refreshToken) {
    accessToken
    user {
      id
      email
      firstName
      lastName
      role
      status
    }
  }
}
```

### Variables

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Success Response (200)

```json
{
  "data": {
    "refreshToken": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "user@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_USER",
        "status": "ACTIVE"
      }
    }
  }
}
```

### Error Response

**Invalid Refresh Token**
```json
{
  "errors": [
    {
      "message": "Invalid or expired refresh token",
      "extensions": {
        "code": "INVALID_REFRESH_TOKEN"
      }
    }
  ],
  "data": null
}
```

---

## 6. Forgot Password

**What this API does:** This API is used for initiating the password reset flow when a user forgets their password. It generates a 6-digit OTP and sends it to the provided email address. For security reasons, this endpoint always returns success even if the email doesn't exist in the system (prevents email enumeration attacks).

**What it returns:** Returns a `MessageResponse` containing a success boolean (always true) and a generic message stating "If an account exists with this email, a password reset code has been sent." The OTP is valid for 10 minutes.

### Request

```graphql
mutation ForgotPassword($input: ForgotPasswordInput!) {
  forgotPassword(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com"
  }
}
```

### Success Response (200)

**Note:** Always returns success to prevent email enumeration attacks.

```json
{
  "data": {
    "forgotPassword": {
      "success": true,
      "message": "If an account exists with this email, a password reset code has been sent."
    }
  }
}
```

---

## 7. Reset Password

**What this API does:** This API is used for completing the password reset flow by setting a new password. It validates the email and OTP combination, ensures the new password meets security requirements, hashes and stores the new password, and invalidates the OTP. The user must then log in with their new password - this does NOT auto-login.

**What it returns:** Returns a `MessageResponse` containing a success boolean and a confirmation message stating "Password has been reset successfully. You can now login with your new password."

### Request

```graphql
mutation ResetPassword($input: ResetPasswordInput!) {
  resetPassword(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "email": "user@example.com",
    "otp": "654321",
    "newPassword": "NewSecurePass456!"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "resetPassword": {
      "success": true,
      "message": "Password has been reset successfully. You can now login with your new password."
    }
  }
}
```

### Error Responses

**Invalid Reset Code**
```json
{
  "errors": [
    {
      "message": "Invalid reset code. Please try again.",
      "extensions": {
        "code": "INVALID_RESET_CODE"
      }
    }
  ],
  "data": null
}
```

**Reset Code Expired**
```json
{
  "errors": [
    {
      "message": "Password reset code has expired. Please request a new one.",
      "extensions": {
        "code": "RESET_EXPIRED"
      }
    }
  ],
  "data": null
}
```

---

# User APIs (Authenticated)

These APIs require a valid access token in the Authorization header. They allow authenticated users to view and manage their own profiles.

**Required Header for all authenticated requests:**
```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

## 8. Get Current User (Me)

**What this API does:** This API is used for retrieving the authenticated user's complete profile information. Call this after login to get the current user data, check session validity, or refresh user information displayed in the UI. It uses the access token to identify the user.

**What it returns:** Returns a `User` object containing all profile fields: id, email, firstName, lastName, phone, role, activeRole, status, isEmailVerified, **pushEnabled**, **lastLoginAt**, providerProfile (for providers), and timestamps.

### Request

```graphql
query Me {
  me {
    id
    email
    firstName
    lastName
    phone
    role
    activeRole
    status
    isEmailVerified
    pushEnabled
    lastLoginAt
    providerProfile {
      id
      businessName
      verificationStatus
    }
    createdAt
    updatedAt
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "me": {
      "id": "507f1f77bcf86cd799439011",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "phone": "+2348012345678",
      "role": "SERVICE_USER",
      "activeRole": "SERVICE_USER",
      "status": "ACTIVE",
      "isEmailVerified": true,
      "pushEnabled": true,
      "lastLoginAt": "2026-03-15T09:00:00.000Z",
      "providerProfile": null,
      "createdAt": "2026-03-08T10:30:00.000Z",
      "updatedAt": "2026-03-08T10:30:00.000Z"
    }
  }
}
```

### Error Response

**Not Authenticated**
```json
{
  "errors": [
    {
      "message": "You must be logged in to perform this action",
      "extensions": {
        "code": "UNAUTHENTICATED"
      }
    }
  ],
  "data": null
}
```

---

## 9. Update Profile

**What this API does:** Updates the authenticated user's (SERVICE_USER or SERVICE_PROVIDER) profile information. Supports `firstName`, `lastName`, `phone`, and `profilePhoto`. All fields are optional — only provided fields are changed. A profile-update notification email is sent automatically. **Email changes are handled separately via `requestEmailChange` + `confirmEmailChange`.**

**What it returns:** Returns the updated `User` object with all current profile fields.

### Request

```graphql
mutation UpdateProfile($input: UpdateProfileInput!) {
  updateProfile(input: $input) {
    id
    email
    firstName
    lastName
    phone
    profilePhoto
    role
    status
    isEmailVerified
    updatedAt
  }
}
```

### Variables

```json
{
  "input": {
    "firstName": "Jonathan",
    "lastName": "Smith",
    "phone": "+2348098765432",
    "profilePhoto": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1/profiles/user_123.jpg"
  }
}
```

> **Note:** `profilePhoto` should be a Cloudinary URL. Upload the image to Cloudinary first, then pass the resulting URL here.

### Success Response (200)

```json
{
  "data": {
    "updateProfile": {
      "id": "507f1f77bcf86cd799439011",
      "email": "user@example.com",
      "firstName": "Jonathan",
      "lastName": "Smith",
      "phone": "+2348098765432",
      "profilePhoto": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1/profiles/user_123.jpg",
      "role": "SERVICE_USER",
      "status": "ACTIVE",
      "isEmailVerified": true,
      "updatedAt": "2026-03-15T11:45:00.000Z"
    }
  }
}
```

---

## 10. Request Email Change

**What this API does:** Initiates an email address change for the authenticated user. Sends a **6-digit OTP to the new email address** to confirm ownership. The current email is NOT changed yet — call `confirmEmailChange` with the OTP to complete the change.

**What it returns:** Returns a `MessageResponse` with `success: true` and a confirmation message.

### Request

```graphql
mutation RequestEmailChange($input: RequestEmailChangeInput!) {
  requestEmailChange(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "newEmail": "newemail@example.com"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "requestEmailChange": {
      "success": true,
      "message": "A confirmation code has been sent to newemail@example.com. It expires in 10 minutes."
    }
  }
}
```

### Error Responses

**Same email as current**
```json
{
  "errors": [{ "message": "New email must be different from your current email", "extensions": { "code": "VALIDATION_ERROR" } }]
}
```

**Email already taken**
```json
{
  "errors": [{ "message": "This email address is already in use", "extensions": { "code": "USER_ALREADY_EXISTS" } }]
}
```

---

## 11. Confirm Email Change

**What this API does:** Verifies the OTP sent to the new email address and commits the email change. After this call, the user's email is permanently updated and a notification is sent to the **old** email address. The OTP expires after 10 minutes.

**What it returns:** Returns the updated `User` object with the new email address.

### Request

```graphql
mutation ConfirmEmailChange($input: ConfirmEmailChangeInput!) {
  confirmEmailChange(input: $input) {
    id
    email
    firstName
    lastName
    phone
    profilePhoto
    role
    status
    isEmailVerified
    updatedAt
  }
}
```

### Variables

```json
{
  "input": {
    "otp": "847291"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "confirmEmailChange": {
      "id": "507f1f77bcf86cd799439011",
      "email": "newemail@example.com",
      "firstName": "Jonathan",
      "lastName": "Smith",
      "phone": "+2348098765432",
      "profilePhoto": null,
      "role": "SERVICE_USER",
      "status": "ACTIVE",
      "isEmailVerified": true,
      "updatedAt": "2026-03-15T12:00:00.000Z"
    }
  }
}
```

### Error Responses

**No pending email change**
```json
{
  "errors": [{ "message": "No pending email change found. Please request a new one.", "extensions": { "code": "INVALID_REQUEST" } }]
}
```

**OTP expired**
```json
{
  "errors": [{ "message": "Confirmation code has expired. Please request a new one.", "extensions": { "code": "OTP_EXPIRED" } }]
}
```

**Wrong OTP**
```json
{
  "errors": [{ "message": "Invalid confirmation code.", "extensions": { "code": "INVALID_OTP" } }]
}
```

---

# Admin APIs (Admin Role Required)

These APIs require an admin access token (ADMIN or SUPER_ADMIN role). They provide platform management capabilities for administrators.

---

## Admin Profile: Update Admin Profile

**What this API does:** Updates the currently authenticated admin's (ADMIN or SUPER_ADMIN) own profile. Supports `firstName`, `lastName`, `phone`, and `profilePhoto`. All fields are optional — only provided fields are updated. A profile-update notification email is sent automatically. **Email changes are handled via `adminRequestEmailChange` + `adminConfirmEmailChange`.**

**What it returns:** Returns the updated `AdminUser` object.

### Request

```graphql
mutation UpdateAdminProfile($input: UpdateAdminInput!) {
  updateAdminProfile(input: $input) {
    id
    email
    firstName
    lastName
    phone
    profilePhoto
    role
    status
    lastLoginAt
    updatedAt
  }
}
```

### Variables

```json
{
  "input": {
    "firstName": "Jane",
    "lastName": "Administrator",
    "phone": "+2348011223344",
    "profilePhoto": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1/admins/admin_123.jpg"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "updateAdminProfile": {
      "id": "507f1f77bcf86cd799439099",
      "email": "admin@easykonect.com",
      "firstName": "Jane",
      "lastName": "Administrator",
      "phone": "+2348011223344",
      "profilePhoto": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1/admins/admin_123.jpg",
      "role": "ADMIN",
      "status": "ACTIVE",
      "lastLoginAt": "2026-03-15T09:00:00.000Z",
      "updatedAt": "2026-03-15T11:45:00.000Z"
    }
  }
}
```

---

## Admin Profile: Request Email Change

**What this API does:** Initiates an email address change for the currently logged-in admin. Sends a **6-digit OTP to the new email address** to confirm ownership. The current email remains active until `adminConfirmEmailChange` is called with the valid OTP.

**What it returns:** Returns a `MessageResponse` with `success: true` and a confirmation message.

### Request

```graphql
mutation AdminRequestEmailChange($input: AdminRequestEmailChangeInput!) {
  adminRequestEmailChange(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "newEmail": "newadmin@easykonect.com"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "adminRequestEmailChange": {
      "success": true,
      "message": "A confirmation code has been sent to newadmin@easykonect.com. It expires in 10 minutes."
    }
  }
}
```

### Error Responses

**Same email as current**
```json
{
  "errors": [{ "message": "New email must be different from your current email", "extensions": { "code": "VALIDATION_ERROR" } }]
}
```

**Email already in use**
```json
{
  "errors": [{ "message": "This email address is already in use", "extensions": { "code": "USER_ALREADY_EXISTS" } }]
}
```

---

## Admin Profile: Confirm Email Change

**What this API does:** Verifies the OTP sent to the new admin email and commits the email change. After this call the admin's email is permanently updated and a notification is sent to the **old** email address. The OTP expires after 10 minutes.

**What it returns:** Returns the updated `AdminUser` object with the new email address.

### Request

```graphql
mutation AdminConfirmEmailChange($input: AdminConfirmEmailChangeInput!) {
  adminConfirmEmailChange(input: $input) {
    id
    email
    firstName
    lastName
    phone
    profilePhoto
    role
    status
    lastLoginAt
    updatedAt
  }
}
```

### Variables

```json
{
  "input": {
    "otp": "739201"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "adminConfirmEmailChange": {
      "id": "507f1f77bcf86cd799439099",
      "email": "newadmin@easykonect.com",
      "firstName": "Jane",
      "lastName": "Administrator",
      "phone": "+2348011223344",
      "profilePhoto": null,
      "role": "ADMIN",
      "status": "ACTIVE",
      "lastLoginAt": "2026-03-15T09:00:00.000Z",
      "updatedAt": "2026-03-15T12:00:00.000Z"
    }
  }
}
```

### Error Responses

**No pending email change**
```json
{
  "errors": [{ "message": "No pending email change found. Please request a new one.", "extensions": { "code": "INVALID_REQUEST" } }]
}
```

**OTP expired**
```json
{
  "errors": [{ "message": "Confirmation code has expired. Please request a new one.", "extensions": { "code": "OTP_EXPIRED" } }]
}
```

**Wrong OTP**
```json
{
  "errors": [{ "message": "Invalid confirmation code.", "extensions": { "code": "INVALID_OTP" } }]
}
```

---

## 10. Get All Users

**What this API does:** This API is used for retrieving a paginated list of all users on the platform. Admins use this to view, search, and manage user accounts. Supports pagination to handle large user bases efficiently.

**What it returns:** Returns a `PaginatedUsers` object containing an `items` array of User objects (each with id, email, firstName, lastName, role, status, isEmailVerified, createdAt), plus pagination metadata (total count, current page, limit, totalPages, hasNextPage, hasPreviousPage).

### Request

```graphql
query GetUsers($pagination: PaginationInput) {
  users(pagination: $pagination) {
    items {
      id
      email
      firstName
      lastName
      role
      status
      isEmailVerified
      createdAt
    }
    total
    page
    limit
    totalPages
    hasNextPage
    hasPreviousPage
  }
}
```

### Variables

```json
{
  "pagination": {
    "page": 1,
    "limit": 10
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "users": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439011",
          "email": "user1@example.com",
          "firstName": "John",
          "lastName": "Doe",
          "role": "SERVICE_USER",
          "status": "ACTIVE",
          "isEmailVerified": true,
          "createdAt": "2026-03-08T10:30:00.000Z"
        }
      ],
      "total": 45,
      "page": 1,
      "limit": 10,
      "totalPages": 5,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

### Error Response

**Unauthorized (Not Admin)**
```json
{
  "errors": [
    {
      "message": "You do not have permission to perform this action",
      "extensions": {
        "code": "UNAUTHORIZED"
      }
    }
  ],
  "data": null
}
```

---

## 11. Delete User

**What this API does:** This API is used for permanently deleting a user account from the platform. It removes the user and all associated data including their provider profile and services (if they were a SERVICE_PROVIDER). This action is irreversible and should only be used for removing spam/fake accounts or GDPR compliance requests.

**What it returns:** Returns a `MessageResponse` containing a success boolean and a message "User deleted successfully".

### Request

```graphql
mutation DeleteUser($id: ID!) {
  deleteUser(id: $id) {
    success
    message
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439011"
}
```

### Success Response (200)

```json
{
  "data": {
    "deleteUser": {
      "success": true,
      "message": "User deleted successfully"
    }
  }
}
```

---

# Booking APIs (User)

These APIs allow users to create, view, update, and cancel bookings for services.

---

## 12. Create Booking

**What this API does:** This API is used for creating a new booking for a service. The user specifies the service they want to book, the scheduled date and time, and the service location. The booking is created with PENDING status and the service provider must accept it before the service can proceed. Bookings must be scheduled at least 2 hours in advance and no more than 30 days out.

**What it returns:** Returns a `Booking` object containing the booking ID, status (PENDING), scheduled date/time, service details, provider information, pricing breakdown (servicePrice, commission, totalAmount), and timestamps.

### Request

```graphql
mutation CreateBooking($input: CreateBookingInput!) {
  createBooking(input: $input) {
    id
    status
    scheduledDate
    scheduledTime
    address
    city
    state
    notes
    servicePrice
    commission
    totalAmount
    service {
      id
      name
      price
      duration
    }
    provider {
      id
      businessName
    }
    user {
      id
      firstName
      lastName
    }
    createdAt
  }
}
```

### Variables

```json
{
  "input": {
    "serviceId": "507f1f77bcf86cd799439011",
    "scheduledDate": "2026-03-20",
    "scheduledTime": "14:00",
    "address": "123 Main Street, Lekki",
    "city": "Lagos",
    "state": "Lagos",
    "notes": "Please bring your own equipment"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "createBooking": {
      "id": "507f1f77bcf86cd799439012",
      "status": "PENDING",
      "scheduledDate": "2026-03-20T00:00:00.000Z",
      "scheduledTime": "14:00",
      "address": "123 Main Street, Lekki",
      "city": "Lagos",
      "state": "Lagos",
      "notes": "Please bring your own equipment",
      "servicePrice": 15000,
      "commission": 1500,
      "totalAmount": 15000,
      "service": {
        "id": "507f1f77bcf86cd799439011",
        "name": "Pipe Repair",
        "price": 15000,
        "duration": 60
      },
      "provider": {
        "id": "507f1f77bcf86cd799439010",
        "businessName": "John's Plumbing Services"
      },
      "user": {
        "id": "507f1f77bcf86cd799439013",
        "firstName": "Jane",
        "lastName": "Customer"
      },
      "createdAt": "2026-03-13T10:30:00.000Z"
    }
  }
}
```

### Error Responses

**Service Not Found**
```json
{
  "errors": [{ "message": "Service not found", "extensions": { "code": "SERVICE_NOT_FOUND" } }],
  "data": null
}
```

**Service Not Available**
```json
{
  "errors": [{ "message": "This service is not currently available for booking", "extensions": { "code": "SERVICE_NOT_AVAILABLE" } }],
  "data": null
}
```

**Invalid Booking Time**
```json
{
  "errors": [{ "message": "Booking must be scheduled at least 2 hours in advance", "extensions": { "code": "INVALID_BOOKING_TIME" } }],
  "data": null
}
```

---

## 13. Get My Bookings

**What this API does:** This API is used for retrieving all bookings made by the currently authenticated user. It supports filtering by status (PENDING, ACCEPTED, IN_PROGRESS, COMPLETED, CANCELLED) and date range. Results are paginated and sorted by creation date (newest first).

**What it returns:** Returns a `PaginatedBookings` object containing an array of bookings with full details, plus pagination metadata (total, page, limit, totalPages, hasNextPage, hasPreviousPage).

### Request

```graphql
query MyBookings($filters: BookingFiltersInput, $pagination: PaginationInput) {
  myBookings(filters: $filters, pagination: $pagination) {
    items {
      id
      status
      scheduledDate
      scheduledTime
      address
      city
      servicePrice
      totalAmount
      service {
        id
        name
        price
      }
      provider {
        businessName
        city
      }
      completedAt
      cancelledAt
      createdAt
    }
    total
    page
    limit
    totalPages
    hasNextPage
    hasPreviousPage
  }
}
```

### Variables

```json
{
  "filters": {
    "status": "PENDING"
  },
  "pagination": {
    "page": 1,
    "limit": 10
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myBookings": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439012",
          "status": "PENDING",
          "scheduledDate": "2026-03-20T00:00:00.000Z",
          "scheduledTime": "14:00",
          "address": "123 Main Street",
          "city": "Lagos",
          "servicePrice": 15000,
          "totalAmount": 15000,
          "service": {
            "id": "507f1f77bcf86cd799439011",
            "name": "Pipe Repair",
            "price": 15000
          },
          "provider": {
            "businessName": "John's Plumbing",
            "city": "Lagos"
          },
          "completedAt": null,
          "cancelledAt": null,
          "createdAt": "2026-03-13T10:30:00.000Z"
        }
      ],
      "total": 1,
      "page": 1,
      "limit": 10,
      "totalPages": 1,
      "hasNextPage": false,
      "hasPreviousPage": false
    }
  }
}
```

---

## 14. Get Booking by ID

**What this API does:** This API is used for retrieving detailed information about a specific booking. Only the booking owner (user who made the booking), the service provider, or an admin can view a booking.

**What it returns:** Returns a complete `Booking` object with all details including service, provider, user, payment status, review (if exists), and all timestamps.

### Request

```graphql
query GetBooking($id: ID!) {
  booking(id: $id) {
    id
    status
    scheduledDate
    scheduledTime
    address
    city
    state
    notes
    servicePrice
    commission
    totalAmount
    service {
      id
      name
      description
      price
      duration
      category {
        name
      }
    }
    provider {
      id
      businessName
      address
      city
    }
    user {
      id
      firstName
      lastName
      email
      phone
    }
    payment {
      id
      status
      amount
      paidAt
    }
    review {
      id
      rating
      comment
    }
    completedAt
    cancelledAt
    cancellationReason
    createdAt
    updatedAt
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439012"
}
```

---

## 15. Update Booking

**What this API does:** This API is used for updating a booking that is still in PENDING status. Users can change the scheduled date/time, address, or notes before the provider accepts the booking. Once a booking is accepted, it cannot be modified.

**What it returns:** Returns the updated `Booking` object with the new values.

### Request

```graphql
mutation UpdateBooking($id: ID!, $input: UpdateBookingInput!) {
  updateBooking(id: $id, input: $input) {
    id
    status
    scheduledDate
    scheduledTime
    address
    city
    state
    notes
    updatedAt
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439012",
  "input": {
    "scheduledDate": "2026-03-21",
    "scheduledTime": "10:00",
    "notes": "Changed to morning appointment"
  }
}
```

### Error Responses

**Invalid Booking Status**
```json
{
  "errors": [{ "message": "Can only update pending bookings", "extensions": { "code": "INVALID_BOOKING_STATUS" } }],
  "data": null
}
```

---

## 16. Cancel Booking

**What this API does:** This API is used for canceling a booking. Users can cancel PENDING bookings anytime. For ACCEPTED bookings, cancellation must be done at least 24 hours before the scheduled time. A reason for cancellation is required.

**What it returns:** Returns the cancelled `Booking` object with status set to CANCELLED, cancelledAt timestamp, and the cancellationReason.

### Request

```graphql
mutation CancelBooking($id: ID!, $reason: String!) {
  cancelBooking(id: $id, reason: $reason) {
    id
    status
    cancelledAt
    cancellationReason
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439012",
  "reason": "Schedule conflict - need to reschedule"
}
```

### Error Responses

**Cancellation Window Passed**
```json
{
  "errors": [{ "message": "Cannot cancel booking within 24 hours of scheduled time. Please contact the provider.", "extensions": { "code": "CANCELLATION_WINDOW_PASSED" } }],
  "data": null
}
```

---

## 17. Get My Booking Stats

**What this API does:** This API is used for retrieving booking statistics for the current user's dashboard. It provides a summary of all bookings, categorized by status, and the total amount spent on completed bookings.

**What it returns:** Returns a `BookingStats` object with totalBookings, pendingBookings, completedBookings, cancelledBookings, and totalSpent.

### Request

```graphql
query MyBookingStats {
  myBookingStats {
    totalBookings
    pendingBookings
    completedBookings
    cancelledBookings
    totalSpent
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myBookingStats": {
      "totalBookings": 15,
      "pendingBookings": 2,
      "completedBookings": 10,
      "cancelledBookings": 3,
      "totalSpent": 125000
    }
  }
}
```

---

# Booking APIs (Provider)

These APIs allow service providers to manage incoming bookings for their services.

---

## 18. Get Provider Bookings

**What this API does:** This API is used for retrieving all bookings for the current provider's services. Providers use this to see incoming booking requests and manage their schedule. Supports filtering by status and date range.

**What it returns:** Returns a `PaginatedBookings` object with bookings for the provider's services.

### Request

```graphql
query ProviderBookings($filters: BookingFiltersInput, $pagination: PaginationInput) {
  providerBookings(filters: $filters, pagination: $pagination) {
    items {
      id
      status
      scheduledDate
      scheduledTime
      address
      city
      servicePrice
      commission
      totalAmount
      service {
        id
        name
      }
      user {
        firstName
        lastName
        phone
        email
      }
      notes
      createdAt
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

---

## 19. Accept Booking

**What this API does:** This API is used for accepting a PENDING booking request. When a provider accepts a booking, the status changes to ACCEPTED and the customer is notified. The provider commits to providing the service at the scheduled time.

**What it returns:** Returns the updated `Booking` object with status set to ACCEPTED.

### Request

```graphql
mutation AcceptBooking($id: ID!) {
  acceptBooking(id: $id) {
    id
    status
    scheduledDate
    scheduledTime
    user {
      firstName
      lastName
      phone
    }
    service {
      name
    }
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439012"
}
```

### Error Responses

**Invalid Status**
```json
{
  "errors": [{ "message": "Cannot accept a booking with status: CANCELLED", "extensions": { "code": "INVALID_BOOKING_STATUS" } }],
  "data": null
}
```

---

## 20. Reject Booking

**What this API does:** This API is used for rejecting a PENDING booking request. Providers should provide a reason so the customer understands why their booking was declined. The customer can then book with another provider.

**What it returns:** Returns the updated `Booking` object with status set to REJECTED and the rejection reason.

### Request

```graphql
mutation RejectBooking($id: ID!, $reason: String!) {
  rejectBooking(id: $id, reason: $reason) {
    id
    status
    cancellationReason
  }
}
```

### Variables

```json
{
  "id": "507f1f77bcf86cd799439012",
  "reason": "Fully booked on this date. Please try another time."
}
```

---

## 21. Start Service

**What this API does:** This API is used when the provider begins providing the service. It changes the booking status from ACCEPTED to IN_PROGRESS. This should be called when the provider arrives at the location or begins the work.

**What it returns:** Returns the updated `Booking` object with status set to IN_PROGRESS.

### Request

```graphql
mutation StartService($id: ID!) {
  startService(id: $id) {
    id
    status
    scheduledDate
    scheduledTime
  }
}
```

### Error Responses

**Invalid Status**
```json
{
  "errors": [{ "message": "Cannot start a booking with status: PENDING. Booking must be ACCEPTED first.", "extensions": { "code": "INVALID_BOOKING_STATUS" } }],
  "data": null
}
```

---

## 22. Complete Service

**What this API does:** This API is used when the provider finishes providing the service. It changes the booking status from IN_PROGRESS to COMPLETED and records the completion timestamp. After completion, the customer can leave a review.

**What it returns:** Returns the updated `Booking` object with status set to COMPLETED and completedAt timestamp.

### Request

```graphql
mutation CompleteService($id: ID!) {
  completeService(id: $id) {
    id
    status
    completedAt
    servicePrice
    totalAmount
  }
}
```

---

## 23. Get Provider Booking Stats

**What this API does:** This API is used for retrieving booking statistics for the provider's dashboard. Shows booking counts by status, total revenue from completed bookings, and completion rate percentage.

**What it returns:** Returns a `BookingStats` object with totalBookings, pendingBookings, completedBookings, cancelledBookings, totalRevenue, and completionRate.

### Request

```graphql
query ProviderBookingStats {
  providerBookingStats {
    totalBookings
    pendingBookings
    completedBookings
    cancelledBookings
    totalRevenue
    completionRate
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "providerBookingStats": {
      "totalBookings": 50,
      "pendingBookings": 5,
      "completedBookings": 40,
      "cancelledBookings": 5,
      "totalRevenue": 600000,
      "completionRate": 80
    }
  }
}
```

---

# Booking Status Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BOOKING STATUS FLOW                          │
└─────────────────────────────────────────────────────────────────────┘

  User creates booking
         │
         ▼
    ┌─────────┐
    │ PENDING │◄─────────────────────────────┐
    └────┬────┘                              │
         │                                   │
    Provider action                    User can cancel
         │                             (before accept)
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌──────────┐
│ACCEPTED│ │ REJECTED │ (end state)
└───┬────┘ └──────────┘
    │
    │ Provider starts
    ▼
┌───────────┐
│IN_PROGRESS│
└─────┬─────┘
      │
      │ Provider completes
      ▼
┌───────────┐
│ COMPLETED │ (end state - customer can review)
└───────────┘

At any point before COMPLETED:
┌───────────┐
│ CANCELLED │ (by user within policy or admin)
└───────────┘
```

---

# Provider Onboarding API

This section covers the full provider onboarding flow: upgrading a `SERVICE_USER` to `SERVICE_PROVIDER`, then uploading documents for verification.

---

## Become a Provider

**What this API does:** Upgrades a `SERVICE_USER` account to `SERVICE_PROVIDER` by creating a business profile in a single atomic transaction. The user's role in the DB changes to `SERVICE_PROVIDER` immediately.

**Critical:** The response includes fresh `accessToken` and `refreshToken` with the new `SERVICE_PROVIDER` role baked in. **You must replace the stored tokens immediately** — the old token still says `SERVICE_USER` and will be rejected by all provider endpoints.

### Request

```graphql
mutation BecomeProvider($input: BecomeProviderInput!) {
  becomeProvider(input: $input) {
    user {
      id
      email
      firstName
      lastName
      role
      activeRole
      pushEnabled
      providerProfile {
        id
        businessName
        verificationStatus
      }
      createdAt
      updatedAt
    }
    accessToken
    refreshToken
  }
}
```

**Variables:**

```json
{
  "input": {
    "businessName": "CleanPro Services",
    "businessDescription": "Professional cleaning services in Lagos",
    "address": "12 Adeola Odeku Street",
    "city": "Lagos",
    "state": "Lagos",
    "country": "Nigeria",
    "latitude": 6.4281,
    "longitude": 3.4219
  }
}
```

**Input fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `businessName` | `String!` | ✅ | Your business or trading name |
| `businessDescription` | `String` | ❌ | Short description of your services |
| `address` | `String!` | ✅ | Street address |
| `city` | `String!` | ✅ | City |
| `state` | `String!` | ✅ | State / province |
| `country` | `String!` | ✅ | Country |
| `latitude` | `Float` | ❌ | GPS latitude for proximity search |
| `longitude` | `Float` | ❌ | GPS longitude for proximity search |

**Authentication:** Required (`Authorization: Bearer <token>`)  
**Role:** `SERVICE_USER` only — existing providers will receive `ALREADY_PROVIDER` error

### Success Response

```json
{
  "data": {
    "becomeProvider": {
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "user@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_PROVIDER",
        "activeRole": "SERVICE_PROVIDER",
        "pushEnabled": true,
        "providerProfile": {
          "id": "provider_id_here",
          "businessName": "CleanPro Services",
          "verificationStatus": "UNVERIFIED"
        },
        "createdAt": "2026-03-08T10:30:00.000Z",
        "updatedAt": "2026-03-30T12:00:00.000Z"
      },
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
}
```

### Error Responses

| Code | Message |
|------|---------|
| `ALREADY_PROVIDER` | You are already registered as a service provider |
| `INVALID_ROLE` | Only service users can become providers |
| `ACCOUNT_NOT_ACTIVE` | Your account must be active to become a provider |
| `EMAIL_NOT_VERIFIED` | Please verify your email before becoming a provider |
| `UNAUTHENTICATED` | Not logged in |

### ⚠️ Critical Frontend Implementation

```typescript
const result = await client.mutate({ mutation: BECOME_PROVIDER, variables: { input } });
const { user, accessToken, refreshToken } = result.data.becomeProvider;

// MUST replace tokens immediately — old token has role SERVICE_USER
storeAccessToken(accessToken);
storeRefreshToken(refreshToken);
updateAuthUser(user);

// Now safe to call uploadProviderDocuments — token has SERVICE_PROVIDER role
```

**Provider onboarding flow:**
1. Call `becomeProvider` → replace tokens immediately from the response
2. Call `uploadProviderDocuments` using the **new** token
3. Call `submitProviderForVerification` when ready
4. Poll `myVerificationStatus` or listen for push notification for approval

---

# Provider Documents API

These APIs allow a service provider to upload verification documents and manage them. Documents are required for the provider verification workflow.

> 🔐 **All document APIs require `SERVICE_PROVIDER` role + valid access token.**

---

## 1. Upload Provider Documents

**What this API does:** Uploads one or more verification documents (ID, business certificate, etc.) to Cloudinary and attaches them to the provider's profile. Maximum **5 documents** total. Accepted formats: `jpg`, `jpeg`, `png`, `pdf`, `doc`, `docx`. Max size per file: **15MB**.

### Request

```graphql
mutation UploadProviderDocuments($files: [FileUploadInput!]!) {
  uploadProviderDocuments(files: $files) {
    success
    urls
    message
  }
}
```

### Variables

```json
{
  "files": [
    {
      "base64Data": "data:application/pdf;base64,JVBERi0xLjQK...",
      "filename": "national_id.pdf"
    },
    {
      "base64Data": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB...",
      "filename": "business_cert.jpg"
    }
  ]
}
```

### Success Response (200)

```json
{
  "data": {
    "uploadProviderDocuments": {
      "success": true,
      "urls": [
        "https://res.cloudinary.com/dhhmhmitl/raw/upload/v1710000000/easykonect/documents/userId_1710000000.pdf",
        "https://res.cloudinary.com/dhhmhmitl/image/upload/v1710000001/easykonect/documents/userId_1710000001.jpg"
      ],
      "message": "2 document(s) uploaded successfully"
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Provider profile not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Maximum 5 documents allowed. You have 4 and are trying to add 2.",
    "extensions": { "code": "MAX_DOCUMENTS_EXCEEDED" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Invalid file format. Allowed formats for document: jpg, jpeg, png, pdf, doc, docx",
    "extensions": { "code": "INVALID_FILE_FORMAT" }
  }]
}
```

```json
{
  "errors": [{
    "message": "File size exceeds maximum allowed (15MB)",
    "extensions": { "code": "FILE_TOO_LARGE" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Unauthorized",
    "extensions": { "code": "UNAUTHORIZED" }
  }]
}
```

> **Notes:**
> - Convert files to base64 before sending. Include the data URI prefix (e.g. `data:application/pdf;base64,...`)
> - Documents are stored under `easykonect/documents/` on Cloudinary
> - The returned URLs are the permanent Cloudinary URLs to store/display

---

## 2. Remove Provider Document

**What this API does:** Removes a specific document from the provider's profile and deletes it from Cloudinary.

### Request

```graphql
mutation RemoveProviderDocument($documentUrl: String!) {
  removeProviderDocument(documentUrl: $documentUrl) {
    success
    message
  }
}
```

### Variables

```json
{
  "documentUrl": "https://res.cloudinary.com/dhhmhmitl/raw/upload/v1710000000/easykonect/documents/userId_1710000000.pdf"
}
```

### Success Response (200)

```json
{
  "data": {
    "removeProviderDocument": {
      "success": true,
      "message": "Document removed successfully"
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Provider profile not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Document not found",
    "extensions": { "code": "DOCUMENT_NOT_FOUND" }
  }]
}
```

---

# Provider Gallery Images API

These APIs allow a service provider to manage their portfolio/gallery images shown on their profile.

> 🔐 **All gallery image APIs require `SERVICE_PROVIDER` role + valid access token.**

---

## 1. Upload Provider Gallery Images

**What this API does:** Uploads one or more gallery/portfolio images to Cloudinary and attaches them to the provider's profile `images` array. Maximum **10 images** total. Accepted formats: `jpg`, `jpeg`, `png`, `webp`, `gif`. Max size per file: **10MB**.

### Request

```graphql
mutation UploadProviderImages($files: [FileUploadInput!]!) {
  uploadProviderImages(files: $files) {
    success
    urls
    message
  }
}
```

### Variables

```json
{
  "files": [
    {
      "base64Data": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB...",
      "filename": "workshop_photo.jpg"
    },
    {
      "base64Data": "data:image/png;base64,iVBORw0KGgoAAAA...",
      "filename": "portfolio_work.png"
    }
  ]
}
```

### Success Response (200)

```json
{
  "data": {
    "uploadProviderImages": {
      "success": true,
      "urls": [
        "https://res.cloudinary.com/dhhmhmitl/image/upload/v1710000000/easykonect/services/userId_1710000000.jpg",
        "https://res.cloudinary.com/dhhmhmitl/image/upload/v1710000001/easykonect/services/userId_1710000001.png"
      ],
      "message": "2 image(s) uploaded successfully"
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Provider profile not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Maximum 10 images allowed. You have 9 and are trying to add 2.",
    "extensions": { "code": "MAX_IMAGES_EXCEEDED" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Invalid file format. Allowed formats for service: jpg, jpeg, png, webp, gif",
    "extensions": { "code": "INVALID_FILE_FORMAT" }
  }]
}
```

```json
{
  "errors": [{
    "message": "File size exceeds maximum allowed (10MB)",
    "extensions": { "code": "FILE_TOO_LARGE" }
  }]
}
```

---

## 2. Remove Provider Gallery Image

**What this API does:** Removes a specific image from the provider's gallery and deletes it from Cloudinary.

### Request

```graphql
mutation RemoveProviderImage($imageUrl: String!) {
  removeProviderImage(imageUrl: $imageUrl) {
    success
    message
  }
}
```

### Variables

```json
{
  "imageUrl": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1710000000/easykonect/services/userId_1710000000.jpg"
}
```

### Success Response (200)

```json
{
  "data": {
    "removeProviderImage": {
      "success": true,
      "message": "Image removed successfully"
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Provider profile not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "Image not found in provider gallery",
    "extensions": { "code": "IMAGE_NOT_FOUND" }
  }]
}
```

> **Tip:** To display a provider's gallery, query `images` on `ServiceProviderProfile`. The `images` array is updated automatically after each upload/remove.

---

# Provider Likes API

These APIs allow users to like/unlike service providers and check like status. Useful for showing "saved providers" or popularity scores.

> 🔐 **Like/unlike mutations and queries require authenticated user (any role).** `providerLikeCount` is public.

---

## 1. Like a Provider

**What this API does:** Adds a like from the authenticated user to a provider. Returns the updated like count.

### Request

```graphql
mutation LikeProvider($providerId: ID!) {
  likeProvider(providerId: $providerId) {
    success
    message
    likeCount
  }
}
```

### Variables

```json
{
  "providerId": "68060a1234abcd5678ef9012"
}
```

### Success Response (200)

```json
{
  "data": {
    "likeProvider": {
      "success": true,
      "message": "You liked Best Provider Co.",
      "likeCount": 42
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Service provider not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "You have already liked this provider",
    "extensions": { "code": "ALREADY_LIKED" }
  }]
}
```

---

## 2. Unlike a Provider

**What this API does:** Removes the authenticated user's like from a provider.

### Request

```graphql
mutation UnlikeProvider($providerId: ID!) {
  unlikeProvider(providerId: $providerId) {
    success
    message
    likeCount
  }
}
```

### Variables

```json
{
  "providerId": "68060a1234abcd5678ef9012"
}
```

### Success Response (200)

```json
{
  "data": {
    "unlikeProvider": {
      "success": true,
      "message": "You unliked Best Provider Co.",
      "likeCount": 41
    }
  }
}
```

### Error Responses

```json
{
  "errors": [{
    "message": "Service provider not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

```json
{
  "errors": [{
    "message": "You have not liked this provider",
    "extensions": { "code": "NOT_LIKED" }
  }]
}
```

---

## 3. Toggle Provider Like

**What this API does:** Likes if not yet liked, unlikes if already liked. Most convenient for a single heart/like button. Returns the new `isLiked` state and updated `likeCount`.

### Request

```graphql
mutation ToggleProviderLike($providerId: ID!) {
  toggleProviderLike(providerId: $providerId) {
    success
    message
    isLiked
    likeCount
  }
}
```

### Variables

```json
{
  "providerId": "68060a1234abcd5678ef9012"
}
```

### Success Response — Liked (200)

```json
{
  "data": {
    "toggleProviderLike": {
      "success": true,
      "message": "You liked Best Provider Co.",
      "isLiked": true,
      "likeCount": 42
    }
  }
}
```

### Success Response — Unliked (200)

```json
{
  "data": {
    "toggleProviderLike": {
      "success": true,
      "message": "You unliked Best Provider Co.",
      "isLiked": false,
      "likeCount": 41
    }
  }
}
```

### Error Response

```json
{
  "errors": [{
    "message": "Service provider not found",
    "extensions": { "code": "NOT_FOUND" }
  }]
}
```

> **Best practice:** Use `toggleProviderLike` for the UI button. Check `isLiked` in the response to update the button state without a separate query.

---

## 4. Check if Provider is Liked

**What this API does:** Returns whether the authenticated user has liked a specific provider, plus the current like count.

### Request

```graphql
query IsProviderLiked($providerId: ID!) {
  isProviderLiked(providerId: $providerId) {
    isLiked
    likeCount
  }
}
```

### Variables

```json
{
  "providerId": "68060a1234abcd5678ef9012"
}
```

### Success Response (200)

```json
{
  "data": {
    "isProviderLiked": {
      "isLiked": true,
      "likeCount": 42
    }
  }
}
```

> **Use case:** Call this when loading a provider profile page to set the initial heart button state.

---

## 5. Get Provider Like Count (Public)

**What this API does:** Returns the total number of likes for a provider. This is public — no authentication required.

### Request

```graphql
query ProviderLikeCount($providerId: ID!) {
  providerLikeCount(providerId: $providerId)
}
```

### Variables

```json
{
  "providerId": "68060a1234abcd5678ef9012"
}
```

### Success Response (200)

```json
{
  "data": {
    "providerLikeCount": 42
  }
}
```

---

## 6. Get My Liked Providers

**What this API does:** Returns a paginated list of all providers the authenticated user has liked, including provider details (name, city, images, rating, like count).

### Request

```graphql
query MyLikedProviders($pagination: PaginationInput) {
  myLikedProviders(pagination: $pagination) {
    items {
      id
      likedAt
      provider {
        id
        businessName
        businessDescription
        verificationStatus
        city
        state
        images
        user {
          id
          firstName
          lastName
          profilePhoto
        }
        reviewCount
        likeCount
      }
    }
    pagination {
      page
      limit
      total
      totalPages
      hasNext
      hasPrev
    }
  }
}
```

### Variables

```json
{
  "pagination": {
    "page": 1,
    "limit": 10
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myLikedProviders": {
      "items": [
        {
          "id": "68060a1234abcd5678ef9013",
          "likedAt": "2026-03-28T10:00:00.000Z",
          "provider": {
            "id": "68060a1234abcd5678ef9012",
            "businessName": "Best Provider Co.",
            "businessDescription": "Professional home services in Lagos",
            "verificationStatus": "VERIFIED",
            "city": "Lagos",
            "state": "Lagos",
            "images": [
              "https://res.cloudinary.com/dhhmhmitl/image/upload/v1710000000/easykonect/services/img1.jpg"
            ],
            "user": {
              "id": "68060a1234abcd5678ef9011",
              "firstName": "John",
              "lastName": "Doe",
              "profilePhoto": "https://res.cloudinary.com/dhhmhmitl/image/upload/v1/profiles/user_123.jpg"
            },
            "reviewCount": 24,
            "likeCount": 42
          }
        }
      ],
      "pagination": {
        "page": 1,
        "limit": 10,
        "total": 3,
        "totalPages": 1,
        "hasNext": false,
        "hasPrev": false
      }
    }
  }
}
```

### Error Response

```json
{
  "errors": [{
    "message": "Unauthorized",
    "extensions": { "code": "UNAUTHENTICATED" }
  }]
}
```

---

# Error Codes Reference

| Code | HTTP Equivalent | Description | Action |
|------|-----------------|-------------|--------|
| `VALIDATION_ERROR` | 400 | Invalid input data | Check input format |
| `UNAUTHENTICATED` | 401 | Missing/invalid token | Login again |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password | Check credentials |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token invalid | Login again |
| `UNAUTHORIZED` | 403 | Insufficient permissions | Need higher role |
| `EMAIL_NOT_VERIFIED` | 403 | Email not verified | Verify email first |
| `ACCOUNT_LOCKED` | 423 | Too many failed logins | Wait and retry |
| `USER_SUSPENDED` | 403 | Account suspended | Contact support |
| `ACCOUNT_DEACTIVATED` | 403 | Account deactivated | Contact support |
| `USER_NOT_FOUND` | 404 | User doesn't exist | Check email/ID |
| `USER_ALREADY_EXISTS` | 409 | Email already registered | Use different email |
| `INVALID_OTP` | 400 | Wrong OTP code | Check code |
| `OTP_EXPIRED` | 400 | OTP expired (10 min) | Request new OTP |
| `ALREADY_VERIFIED` | 400 | Email already verified | Proceed to login |
| `SERVICE_NOT_FOUND` | 404 | Service doesn't exist | Check service ID |
| `SERVICE_NOT_AVAILABLE` | 400 | Service not active | Choose another service |
| `PROVIDER_NOT_VERIFIED` | 403 | Provider not verified | Choose verified provider |
| `BOOKING_NOT_FOUND` | 404 | Booking doesn't exist | Check booking ID |
| `INVALID_BOOKING_TIME` | 400 | Invalid schedule time | Schedule 2h-30d ahead |
| `INVALID_BOOKING_STATUS` | 400 | Wrong booking status | Check current status |
| `CANCELLATION_WINDOW_PASSED` | 400 | Too late to cancel | Contact provider |
| `PROVIDER_NOT_FOUND` | 404 | Provider profile missing | Complete provider setup |
| `MAX_DOCUMENTS_EXCEEDED` | 400 | Document limit reached (5) | Remove a document first |
| `MAX_IMAGES_EXCEEDED` | 400 | Image limit reached (10) | Remove an image first |
| `INVALID_FILE_FORMAT` | 400 | Unsupported file type | Use allowed formats |
| `FILE_TOO_LARGE` | 400 | File exceeds size limit | Compress or resize file |
| `TOO_MANY_FILES` | 400 | Too many files in one upload | Upload in batches |
| `UPLOAD_FAILED` | 500 | Cloudinary upload error | Retry the upload |
| `DOCUMENT_NOT_FOUND` | 404 | Document URL not in profile | Check documentUrl |
| `IMAGE_NOT_FOUND` | 404 | Image URL not in gallery | Check imageUrl |
| `ALREADY_LIKED` | 400 | Provider already liked | Call unlike instead |
| `NOT_LIKED` | 400 | Provider was not liked | Call like instead |

---

# Frontend Implementation Examples

## React/React Native (Apollo Client)

```javascript
import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';

// Create HTTP link
const httpLink = createHttpLink({
  uri: 'http://localhost:3000/api/graphql',
});

// Add auth header
const authLink = setContext((_, { headers }) => {
  const token = localStorage.getItem('accessToken'); // or AsyncStorage for React Native
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    }
  };
});

// Create client
const client = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
});

// Usage
import { gql, useMutation } from '@apollo/client';

const LOGIN_MUTATION = gql`
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      user { id email firstName }
      accessToken
      refreshToken
    }
  }
`;

function LoginComponent() {
  const [login, { loading, error }] = useMutation(LOGIN_MUTATION);
  
  const handleLogin = async () => {
    const { data } = await login({
      variables: {
        input: { email: 'user@example.com', password: 'SecurePass123!' }
      }
    });
    
    localStorage.setItem('accessToken', data.login.accessToken);
    localStorage.setItem('refreshToken', data.login.refreshToken);
  };
}
```

## Flutter (graphql_flutter)

```dart
import 'package:graphql_flutter/graphql_flutter.dart';

final HttpLink httpLink = HttpLink('http://localhost:3000/api/graphql');

final AuthLink authLink = AuthLink(
  getToken: () async => 'Bearer ${await getToken()}',
);

final Link link = authLink.concat(httpLink);

final GraphQLClient client = GraphQLClient(
  link: link,
  cache: GraphQLCache(),
);

// Usage
const String loginMutation = r'''
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      user { id email firstName }
      accessToken
      refreshToken
    }
  }
''';

final result = await client.mutate(
  MutationOptions(
    document: gql(loginMutation),
    variables: {
      'input': {
        'email': 'user@example.com',
        'password': 'SecurePass123!',
      },
    },
  ),
);
```

## Axios (Simple HTTP)

```javascript
import axios from 'axios';

const graphqlClient = axios.create({
  baseURL: 'http://localhost:3000/api/graphql',
  headers: { 'Content-Type': 'application/json' },
});

// Add auth interceptor
graphqlClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Usage
const login = async (email, password) => {
  const response = await graphqlClient.post('', {
    query: `
      mutation Login($input: LoginInput!) {
        login(input: $input) {
          user { id email firstName }
          accessToken
          refreshToken
        }
      }
    `,
    variables: {
      input: { email, password }
    }
  });
  
  return response.data;
};
```

---

# Payment APIs

These APIs handle payment processing, wallet management, bank accounts, and withdrawals. Integration uses Paystack as the payment gateway.

## Payment System Overview

| Component | Description |
|-----------|-------------|
| **Payments** | User pays for booking via Paystack or Wallet |
| **Wallet** | User/Provider balance for quick payments & earnings |
| **Bank Accounts** | Provider's bank accounts for withdrawals |
| **Withdrawals** | Provider requests payout to bank account |
| **Scheduled Payouts** | Automatic payouts based on schedule |

### Payment Flow

```
1. User creates booking → PENDING
2. Provider accepts booking → ACCEPTED
3. User pays (Paystack or Wallet) → Payment COMPLETED, Booking ACCEPTED
4. Provider completes service → Booking COMPLETED
5. Funds released to provider wallet
6. Provider requests withdrawal → Funds transferred to bank
```

### Commission Structure

- **Platform Commission**: 10% of service price
- **Paystack Fee**: ~1.5% + ₦100 (deducted from payment)
- **Withdrawal Fee**: ₦50 per withdrawal

---

## 1. Initialize Payment

**What this API does:** Starts the payment process for a booking. Returns a Paystack authorization URL that the user should be redirected to for payment. The booking must be in ACCEPTED status.

**What it returns:** Returns `PaymentInitializationResponse` containing the payment record, Paystack authorization URL, access code, and transaction reference.

### Request

```graphql
mutation InitializePayment($input: InitializePaymentInput!) {
  initializePayment(input: $input) {
    payment {
      id
      amount
      commission
      providerPayout
      status
      transactionRef
    }
    authorizationUrl
    accessCode
    reference
  }
}
```

### Variables

```json
{
  "input": {
    "bookingId": "507f1f77bcf86cd799439012",
    "callbackUrl": "https://yourapp.com/payment/callback"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "initializePayment": {
      "payment": {
        "id": "507f1f77bcf86cd799439020",
        "amount": 15000,
        "commission": 1500,
        "providerPayout": 13500,
        "status": "PENDING",
        "transactionRef": "PAY_abc123xyz"
      },
      "authorizationUrl": "https://checkout.paystack.com/abc123xyz",
      "accessCode": "abc123xyz",
      "reference": "PAY_abc123xyz"
    }
  }
}
```

### Frontend Integration

```javascript
// Initialize payment
const { data } = await initializePayment({ bookingId });

// Redirect to Paystack checkout
window.location.href = data.initializePayment.authorizationUrl;

// OR use Paystack Inline (recommended)
const handler = PaystackPop.setup({
  key: 'pk_live_xxxxx', // Your Paystack public key
  email: user.email,
  amount: payment.amount * 100, // Paystack uses kobo
  ref: data.initializePayment.reference,
  callback: (response) => {
    // Verify payment
    verifyPayment(response.reference);
  },
  onClose: () => {
    console.log('Payment cancelled');
  }
});
handler.openIframe();
```

### Error Responses

**Booking Not Found**
```json
{
  "errors": [{ "message": "Booking not found", "extensions": { "code": "BOOKING_NOT_FOUND" } }]
}
```

**Booking Not Accepted**
```json
{
  "errors": [{ "message": "Cannot pay for booking in current status", "extensions": { "code": "INVALID_BOOKING_STATUS" } }]
}
```

**Payment Already Exists**
```json
{
  "errors": [{ "message": "Payment already exists for this booking", "extensions": { "code": "PAYMENT_EXISTS" } }]
}
```

---

## 2. Verify Payment

**What this API does:** Verifies a payment after Paystack callback. Should be called after user returns from Paystack checkout or from your callback URL. Updates payment status based on Paystack verification.

**What it returns:** Returns `PaymentVerificationResponse` with the updated payment, verification status, and message.

### Request

```graphql
mutation VerifyPayment($transactionRef: String!) {
  verifyPayment(transactionRef: $transactionRef) {
    payment {
      id
      amount
      status
      paidAt
    }
    verified
    message
  }
}
```

### Variables

```json
{
  "transactionRef": "PAY_abc123xyz"
}
```

### Success Response (200)

```json
{
  "data": {
    "verifyPayment": {
      "payment": {
        "id": "507f1f77bcf86cd799439020",
        "amount": 15000,
        "status": "COMPLETED",
        "paidAt": "2026-04-06T14:30:00.000Z"
      },
      "verified": true,
      "message": "Payment verified successfully"
    }
  }
}
```

### Failed Verification

```json
{
  "data": {
    "verifyPayment": {
      "payment": {
        "id": "507f1f77bcf86cd799439020",
        "amount": 15000,
        "status": "FAILED",
        "paidAt": null
      },
      "verified": false,
      "message": "Payment verification failed"
    }
  }
}
```

---

## 3. Pay with Wallet

**What this API does:** Pays for a booking using the user's wallet balance. The user must have sufficient balance. Instantly completes payment without external redirect.

**What it returns:** Returns `WalletPaymentResult` with success status, remaining balance, and transaction details.

### Request

```graphql
mutation PayWithWallet($input: WalletPaymentInput!) {
  payWithWallet(input: $input) {
    success
    message
    remainingBalance
    transaction {
      id
      type
      amount
      balanceAfter
      description
    }
  }
}
```

### Variables

```json
{
  "input": {
    "bookingId": "507f1f77bcf86cd799439012"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "payWithWallet": {
      "success": true,
      "message": "Payment completed successfully",
      "remainingBalance": 35000,
      "transaction": {
        "id": "507f1f77bcf86cd799439025",
        "type": "DEBIT",
        "amount": 15000,
        "balanceAfter": 35000,
        "description": "Payment for booking #507f1f77bcf86cd799439012"
      }
    }
  }
}
```

### Error Responses

**Insufficient Balance**
```json
{
  "errors": [{ "message": "Insufficient wallet balance", "extensions": { "code": "INSUFFICIENT_BALANCE" } }]
}
```

**Wallet Locked**
```json
{
  "errors": [{ "message": "Your wallet is currently locked. Please contact support.", "extensions": { "code": "WALLET_LOCKED" } }]
}
```

---

## 4. Get My Wallet

**What this API does:** Retrieves the authenticated user's wallet information including balance, pending balance, and lock status.

**What it returns:** Returns `Wallet` object with current balance details.

### Request

```graphql
query MyWallet {
  myWallet {
    id
    balance
    pendingBalance
    isLocked
    lockReason
    createdAt
    updatedAt
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myWallet": {
      "id": "507f1f77bcf86cd799439030",
      "balance": 50000,
      "pendingBalance": 15000,
      "isLocked": false,
      "lockReason": null,
      "createdAt": "2026-03-01T00:00:00.000Z",
      "updatedAt": "2026-04-06T14:30:00.000Z"
    }
  }
}
```

---

## 5. Get Wallet Transactions

**What this API does:** Retrieves the user's wallet transaction history with optional filters for transaction type, source, and date range.

**What it returns:** Returns `PaginatedWalletTransactions` with transaction list and pagination info.

### Request

```graphql
query MyWalletTransactions($filters: WalletTransactionFiltersInput, $pagination: PaginationInput) {
  myWalletTransactions(filters: $filters, pagination: $pagination) {
    items {
      id
      type
      source
      amount
      balanceAfter
      description
      referenceId
      createdAt
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

### Variables

```json
{
  "filters": {
    "type": "CREDIT",
    "startDate": "2026-04-01",
    "endDate": "2026-04-30"
  },
  "pagination": {
    "page": 1,
    "limit": 20
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myWalletTransactions": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439025",
          "type": "CREDIT",
          "source": "BOOKING_PAYMENT",
          "amount": 13500,
          "balanceAfter": 50000,
          "description": "Earnings from booking #507f1f77bcf86cd799439012",
          "referenceId": "507f1f77bcf86cd799439012",
          "createdAt": "2026-04-06T14:30:00.000Z"
        }
      ],
      "total": 15,
      "page": 1,
      "totalPages": 1,
      "hasNextPage": false
    }
  }
}
```

### Transaction Types

| Type | Description |
|------|-------------|
| `CREDIT` | Money added to wallet |
| `DEBIT` | Money removed from wallet |

### Transaction Sources

| Source | Description |
|--------|-------------|
| `BOOKING_PAYMENT` | User paid for a booking |
| `BOOKING_EARNING` | Provider earned from completed booking |
| `WITHDRAWAL` | Provider withdrew to bank |
| `REFUND` | Refund from cancelled booking |
| `ADMIN_ADJUSTMENT` | Admin adjusted balance |

---

# Bank Account APIs (Provider)

These APIs allow service providers to manage their bank accounts for receiving withdrawals.

---

## 1. List Available Banks

**What this API does:** Retrieves list of all Nigerian banks supported by Paystack.

**What it returns:** Returns array of `Bank` objects with bank details.

### Request

```graphql
query ListBanks {
  banks {
    id
    name
    code
    slug
    country
    currency
    active
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "banks": [
      {
        "id": 1,
        "name": "Access Bank",
        "code": "044",
        "slug": "access-bank",
        "country": "Nigeria",
        "currency": "NGN",
        "active": true
      },
      {
        "id": 2,
        "name": "First Bank of Nigeria",
        "code": "011",
        "slug": "first-bank-of-nigeria",
        "country": "Nigeria",
        "currency": "NGN",
        "active": true
      }
    ]
  }
}
```

---

## 2. Verify Bank Account

**What this API does:** Verifies a bank account number with Paystack to get the account holder's name before adding.

**What it returns:** Returns `BankAccountVerification` with account number and name.

### Request

```graphql
query VerifyBankAccount($accountNumber: String!, $bankCode: String!) {
  verifyBankAccount(accountNumber: $accountNumber, bankCode: $bankCode) {
    accountNumber
    accountName
    bankId
  }
}
```

### Variables

```json
{
  "accountNumber": "0123456789",
  "bankCode": "044"
}
```

### Success Response (200)

```json
{
  "data": {
    "verifyBankAccount": {
      "accountNumber": "0123456789",
      "accountName": "JOHN DOE SMITH",
      "bankId": 1
    }
  }
}
```

### Error Response

**Invalid Account**
```json
{
  "errors": [{ "message": "Could not verify account. Please check the account number and bank.", "extensions": { "code": "ACCOUNT_VERIFICATION_FAILED" } }]
}
```

---

## 3. Add Bank Account

**What this API does:** Adds a verified bank account to the provider's profile for receiving withdrawals.

**What it returns:** Returns the created `ProviderBankAccount`.

### Request

```graphql
mutation AddBankAccount($input: AddBankAccountInput!) {
  addBankAccount(input: $input) {
    id
    bankCode
    bankName
    accountNumber
    accountName
    isDefault
    isVerified
    createdAt
  }
}
```

### Variables

```json
{
  "input": {
    "bankCode": "044",
    "accountNumber": "0123456789"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "addBankAccount": {
      "id": "507f1f77bcf86cd799439035",
      "bankCode": "044",
      "bankName": "Access Bank",
      "accountNumber": "0123456789",
      "accountName": "JOHN DOE SMITH",
      "isDefault": true,
      "isVerified": true,
      "createdAt": "2026-04-06T15:00:00.000Z"
    }
  }
}
```

---

## 4. Get My Bank Accounts

**What this API does:** Retrieves all bank accounts linked to the provider's profile.

**What it returns:** Returns array of `ProviderBankAccount` objects.

### Request

```graphql
query MyBankAccounts {
  myBankAccounts {
    id
    bankCode
    bankName
    accountNumber
    accountName
    isDefault
    isVerified
    createdAt
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myBankAccounts": [
      {
        "id": "507f1f77bcf86cd799439035",
        "bankCode": "044",
        "bankName": "Access Bank",
        "accountNumber": "0123456789",
        "accountName": "JOHN DOE SMITH",
        "isDefault": true,
        "isVerified": true,
        "createdAt": "2026-04-06T15:00:00.000Z"
      }
    ]
  }
}
```

---

## 5. Set Default Bank Account

**What this API does:** Sets a bank account as the default for receiving withdrawals.

**What it returns:** Returns the updated `ProviderBankAccount`.

### Request

```graphql
mutation SetDefaultBankAccount($id: ID!) {
  setDefaultBankAccount(id: $id) {
    id
    isDefault
  }
}
```

---

## 6. Remove Bank Account

**What this API does:** Removes a bank account from the provider's profile.

**What it returns:** Returns `MessageResponse` with success status.

### Request

```graphql
mutation RemoveBankAccount($id: ID!) {
  removeBankAccount(id: $id) {
    success
    message
  }
}
```

---

# Withdrawal APIs (Provider)

These APIs allow service providers to withdraw earnings from their wallet to their bank accounts.

---

## 1. Request Withdrawal

**What this API does:** Initiates a withdrawal from the provider's wallet to their bank account. Withdrawal is processed within 24 hours.

**What it returns:** Returns `WithdrawalResult` with withdrawal details.

### Request

```graphql
mutation RequestWithdrawal($input: RequestWithdrawalInput!) {
  requestWithdrawal(input: $input) {
    success
    message
    withdrawal {
      id
      amount
      fee
      netAmount
      status
      bankAccountSnapshot {
        bankName
        accountNumber
        accountName
      }
      createdAt
    }
  }
}
```

### Variables

```json
{
  "input": {
    "amount": 25000,
    "bankAccountId": "507f1f77bcf86cd799439035"
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "requestWithdrawal": {
      "success": true,
      "message": "Withdrawal request submitted successfully",
      "withdrawal": {
        "id": "507f1f77bcf86cd799439040",
        "amount": 25000,
        "fee": 50,
        "netAmount": 24950,
        "status": "PENDING",
        "bankAccountSnapshot": {
          "bankName": "Access Bank",
          "accountNumber": "0123456789",
          "accountName": "JOHN DOE SMITH"
        },
        "createdAt": "2026-04-06T16:00:00.000Z"
      }
    }
  }
}
```

### Error Responses

**Insufficient Balance**
```json
{
  "errors": [{ "message": "Insufficient balance for withdrawal", "extensions": { "code": "INSUFFICIENT_BALANCE" } }]
}
```

**Minimum Amount**
```json
{
  "errors": [{ "message": "Minimum withdrawal amount is ₦100", "extensions": { "code": "MINIMUM_AMOUNT" } }]
}
```

**Daily Limit Exceeded**
```json
{
  "errors": [{ "message": "Daily withdrawal limit of ₦5,000,000 exceeded", "extensions": { "code": "DAILY_LIMIT_EXCEEDED" } }]
}
```

---

## 2. Get My Withdrawals

**What this API does:** Retrieves the provider's withdrawal history with optional filters.

**What it returns:** Returns `PaginatedWithdrawals` with withdrawal list.

### Request

```graphql
query MyWithdrawals($filters: WithdrawalFiltersInput, $pagination: PaginationInput) {
  myWithdrawals(filters: $filters, pagination: $pagination) {
    items {
      id
      amount
      fee
      netAmount
      status
      bankAccountSnapshot {
        bankName
        accountNumber
      }
      processedAt
      failureReason
      createdAt
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

### Variables

```json
{
  "filters": {
    "status": "COMPLETED"
  },
  "pagination": {
    "page": 1,
    "limit": 10
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myWithdrawals": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439040",
          "amount": 25000,
          "fee": 50,
          "netAmount": 24950,
          "status": "COMPLETED",
          "bankAccountSnapshot": {
            "bankName": "Access Bank",
            "accountNumber": "0123456789"
          },
          "processedAt": "2026-04-06T18:00:00.000Z",
          "failureReason": null,
          "createdAt": "2026-04-06T16:00:00.000Z"
        }
      ],
      "total": 5,
      "page": 1,
      "totalPages": 1,
      "hasNextPage": false
    }
  }
}
```

### Withdrawal Statuses

| Status | Description |
|--------|-------------|
| `PENDING` | Withdrawal requested, awaiting processing |
| `PROCESSING` | Transfer initiated with Paystack |
| `COMPLETED` | Successfully transferred to bank |
| `FAILED` | Transfer failed, funds returned to wallet |
| `CANCELLED` | Cancelled by provider before processing |

---

## 3. Cancel Withdrawal

**What this API does:** Cancels a pending withdrawal request. Only pending withdrawals can be cancelled.

**What it returns:** Returns `MessageResponse` with success status.

### Request

```graphql
mutation CancelWithdrawal($id: ID!) {
  cancelWithdrawal(id: $id) {
    success
    message
  }
}
```

### Error Response

**Cannot Cancel**
```json
{
  "errors": [{ "message": "Only pending withdrawals can be cancelled", "extensions": { "code": "INVALID_STATUS" } }]
}
```

---

# Payout Schedule APIs (Provider)

These APIs allow providers to set up automatic scheduled payouts.

---

## 1. Set Payout Schedule

**What this API does:** Configures automatic payouts based on a schedule.

**What it returns:** Returns the created/updated `PayoutSchedule`.

### Request

```graphql
mutation SetPayoutSchedule($input: SetPayoutScheduleInput!) {
  setPayoutSchedule(input: $input) {
    id
    frequency
    minimumAmount
    nextPayoutDate
    isActive
    createdAt
  }
}
```

### Variables

```json
{
  "input": {
    "frequency": "WEEKLY",
    "minimumAmount": 10000
  }
}
```

### Payout Frequencies

| Frequency | Description |
|-----------|-------------|
| `DAILY` | Every day at midnight |
| `WEEKLY` | Every Monday at midnight |
| `BIWEEKLY` | Every other Monday |
| `MONTHLY` | 1st of each month |

---

## 2. Get My Payout Schedule

**What this API does:** Retrieves the provider's current payout schedule.

### Request

```graphql
query MyPayoutSchedule {
  myPayoutSchedule {
    id
    frequency
    minimumAmount
    nextPayoutDate
    isActive
  }
}
```

---

## 3. Disable Payout Schedule

**What this API does:** Disables automatic payouts.

### Request

```graphql
mutation DisablePayoutSchedule {
  disablePayoutSchedule {
    success
    message
  }
}
```

---

## 4. Get Pending Earnings

**What this API does:** Shows provider's pending earnings that are awaiting clearance.

### Request

```graphql
query MyPendingEarnings {
  myPendingEarnings {
    totalPending
    availableNow
    pendingClearance
    nextAvailableDate
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myPendingEarnings": {
      "totalPending": 45000,
      "availableNow": 30000,
      "pendingClearance": 15000,
      "nextAvailableDate": "2026-04-08T00:00:00.000Z"
    }
  }
}
```

---

# Payment APIs (Admin)

These APIs are for admin management of payments, refunds, and withdrawals.

---

## 1. Get All Payments

**What this API does:** Retrieves all platform payments with filters.

### Request

```graphql
query AllPayments($filters: PaymentFiltersInput, $pagination: PaginationInput) {
  allPayments(filters: $filters, pagination: $pagination) {
    items {
      id
      amount
      commission
      providerPayout
      status
      transactionRef
      paidAt
      booking {
        id
        status
        user { firstName lastName }
        provider { businessName }
      }
    }
    total
    page
    totalPages
  }
}
```

---

## 2. Get Payment Statistics

**What this API does:** Retrieves platform-wide payment statistics.

### Request

```graphql
query PaymentStats {
  paymentStats {
    totalPayments
    completedPayments
    pendingPayments
    failedPayments
    refundedPayments
    totalRevenue
    totalCommission
    totalProviderPayouts
    commissionRate
  }
}
```

---

## 3. Process Refund

**What this API does:** Processes a refund for a completed payment.

### Request

```graphql
mutation ProcessRefund($input: RefundInput!) {
  processRefund(input: $input) {
    success
    message
    payment {
      id
      status
      refundAmount
      refundedAt
    }
  }
}
```

### Variables

```json
{
  "input": {
    "paymentId": "507f1f77bcf86cd799439020",
    "amount": 15000,
    "reason": "Service not delivered as expected"
  }
}
```

---

## 4. Process Withdrawal (Admin)

**What this API does:** Manually processes a pending provider withdrawal.

### Request

```graphql
mutation ProcessWithdrawal($id: ID!) {
  processWithdrawal(id: $id) {
    success
    message
    withdrawal {
      id
      status
      processedAt
    }
  }
}
```

---

## 5. Reject Withdrawal (Admin)

**What this API does:** Rejects a withdrawal request with reason.

### Request

```graphql
mutation RejectWithdrawal($id: ID!, $reason: String!) {
  rejectWithdrawal(id: $id, reason: $reason) {
    success
    message
    withdrawal {
      id
      status
      failureReason
    }
  }
}
```

---

## 6. Adjust Wallet Balance (Admin)

**What this API does:** Adjusts a user's wallet balance (credit or debit). Maximum ₦10,000,000 per adjustment.

### Request

```graphql
mutation AdjustWalletBalance($userId: ID!, $amount: Float!, $reason: String!) {
  adjustWalletBalance(userId: $userId, amount: $amount, reason: $reason) {
    id
    balance
    updatedAt
  }
}
```

### Variables

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "amount": 5000,
  "reason": "Compensation for service issue"
}
```

> **Note:** Use positive amount for credit, negative for debit.

---

# Messaging APIs

These APIs handle real-time messaging between users, providers, and admins. Authentication is required for all endpoints.

---

## Chat System Overview

The messaging system supports multiple conversation types:

| Conversation Type | Participants | Use Case |
|-------------------|--------------|----------|
| `USER_PROVIDER` | User ↔ Provider | Service inquiries, booking discussions |
| `USER_ADMIN` | User/Provider ↔ Admin | Support requests, help |
| `ADMIN_SUPERADMIN` | Admin ↔ Super Admin | Internal admin communication |
| `BOOKING_RELATED` | User ↔ Provider | Chat tied to a specific booking |

---

## 1. Start a Conversation

**What this API does:** Creates a new conversation with another user or returns an existing one. The system automatically determines the conversation type based on participant roles.

### Request

```graphql
mutation StartConversation($input: StartConversationInput!) {
  startConversation(input: $input) {
    id
    type
    participantIds
    subject
    isActive
    lastMessageAt
    lastMessageText
    createdAt
    otherParticipant {
      id
      firstName
      lastName
      profilePhoto
      role
      businessName
    }
    unreadCount
  }
}
```

### Variables

```json
{
  "input": {
    "participantId": "provider_user_id_here",
    "subject": "Question about your service",
    "initialMessage": "Hi, I have a question about your cleaning service..."
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "startConversation": {
      "id": "conv_123",
      "type": "USER_PROVIDER",
      "participantIds": ["user_123", "provider_456"],
      "subject": "Question about your service",
      "isActive": true,
      "lastMessageAt": "2026-03-14T10:30:00Z",
      "lastMessageText": "Hi, I have a question about your cleaning service...",
      "createdAt": "2026-03-14T10:30:00Z",
      "otherParticipant": {
        "id": "provider_456",
        "firstName": "Jane",
        "lastName": "Smith",
        "profilePhoto": "https://res.cloudinary.com/...",
        "role": "SERVICE_PROVIDER",
        "businessName": "CleanPro Services"
      },
      "unreadCount": 0
    }
  }
}
```

---

## 2. Start Support Chat (with Admin)

**What this API does:** Creates a support conversation with an available admin. Used when users or providers need help from support staff.

### Request

```graphql
mutation StartSupportChat($input: StartSupportChatInput!) {
  startSupportChat(input: $input) {
    id
    type
    subject
    isActive
    createdAt
    otherParticipant {
      id
      firstName
      lastName
      role
    }
  }
}
```

### Variables

```json
{
  "input": {
    "subject": "Payment Issue",
    "initialMessage": "I'm having trouble with my payment. It shows failed but money was deducted."
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "startSupportChat": {
      "id": "conv_support_123",
      "type": "USER_ADMIN",
      "subject": "Payment Issue",
      "isActive": true,
      "createdAt": "2026-03-14T10:30:00Z",
      "otherParticipant": {
        "id": "admin_789",
        "firstName": "Support",
        "lastName": "Admin",
        "role": "ADMIN"
      }
    }
  }
}
```

---

## 3. Get Booking Conversation

**What this API does:** Gets or creates a conversation tied to a specific booking. Only the user and provider involved in the booking can access this.

### Request

```graphql
query BookingConversation($bookingId: ID!) {
  bookingConversation(bookingId: $bookingId) {
    id
    type
    bookingId
    isActive
    lastMessageAt
    lastMessageText
    otherParticipant {
      id
      firstName
      lastName
      profilePhoto
      businessName
    }
    unreadCount
  }
}
```

### Variables

```json
{
  "bookingId": "booking_123"
}
```

---

## 4. Send a Message

**What this API does:** Sends a message in an existing conversation. Supports text content and optional attachments.

### Request

```graphql
mutation SendMessage($input: SendMessageInput!) {
  sendMessage(input: $input) {
    id
    conversationId
    senderId
    senderRole
    content
    attachments
    status
    createdAt
    sender {
      id
      firstName
      lastName
      profilePhoto
    }
  }
}
```

### Variables

```json
{
  "input": {
    "conversationId": "conv_123",
    "content": "Yes, I can do the service tomorrow at 2 PM. Does that work for you?",
    "attachments": ["https://res.cloudinary.com/...image1.jpg"]
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "sendMessage": {
      "id": "msg_456",
      "conversationId": "conv_123",
      "senderId": "provider_456",
      "senderRole": "SERVICE_PROVIDER",
      "content": "Yes, I can do the service tomorrow at 2 PM. Does that work for you?",
      "attachments": ["https://res.cloudinary.com/...image1.jpg"],
      "status": "SENT",
      "createdAt": "2026-03-14T10:35:00Z",
      "sender": {
        "id": "provider_456",
        "firstName": "Jane",
        "lastName": "Smith",
        "profilePhoto": "https://res.cloudinary.com/..."
      }
    }
  }
}
```

---

## 5. Get My Conversations

**What this API does:** Returns a paginated list of all the user's conversations, sorted by most recent activity.

### Request

```graphql
query MyConversations($pagination: PaginationInput) {
  myConversations(pagination: $pagination) {
    conversations {
      id
      type
      subject
      bookingId
      isActive
      lastMessageAt
      lastMessageText
      otherParticipant {
        id
        firstName
        lastName
        profilePhoto
        role
        businessName
      }
      unreadCount
    }
    total
    page
    limit
    totalPages
    hasNextPage
    hasPreviousPage
  }
}
```

### Variables

```json
{
  "pagination": {
    "page": 1,
    "limit": 20
  }
}
```

---

## 6. Get Conversation Messages

**What this API does:** Returns paginated messages for a specific conversation, ordered chronologically.

### Request

```graphql
query ConversationMessages($conversationId: ID!, $pagination: PaginationInput) {
  conversationMessages(conversationId: $conversationId, pagination: $pagination) {
    messages {
      id
      conversationId
      senderId
      senderRole
      content
      attachments
      status
      readBy
      readAt
      replyToId
      isDeleted
      createdAt
      sender {
        id
        firstName
        lastName
        profilePhoto
      }
    }
    total
    page
    limit
    totalPages
    hasNextPage
    hasPreviousPage
  }
}
```

### Variables

```json
{
  "conversationId": "conv_123",
  "pagination": {
    "page": 1,
    "limit": 50
  }
}
```

---

## 7. Mark Messages as Read

**What this API does:** Marks messages in a conversation as read by the current user.

### Request

```graphql
mutation MarkMessagesAsRead($conversationId: ID!, $messageIds: [ID!]) {
  markMessagesAsRead(conversationId: $conversationId, messageIds: $messageIds) {
    success
    message
  }
}
```

### Variables

```json
{
  "conversationId": "conv_123",
  "messageIds": ["msg_1", "msg_2", "msg_3"]
}
```

**Note:** If `messageIds` is omitted, all unread messages in the conversation will be marked as read.

---

## 8. Get Unread Message Count

**What this API does:** Returns the total count of unread messages across all conversations.

### Request

```graphql
query UnreadMessageCount {
  unreadMessageCount {
    count
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "unreadMessageCount": {
      "count": 5
    }
  }
}
```

---

## 9. Archive a Conversation

**What this API does:** Archives a conversation, hiding it from the active conversation list.

### Request

```graphql
mutation ArchiveConversation($conversationId: ID!) {
  archiveConversation(conversationId: $conversationId) {
    success
    message
  }
}
```

---

## 10. Delete a Message

**What this API does:** Soft-deletes a message (only the sender can delete their own messages).

### Request

```graphql
mutation DeleteMessage($messageId: ID!) {
  deleteMessage(messageId: $messageId) {
    success
    message
  }
}
```

---

# Notification APIs

These APIs handle system notifications for booking updates, reviews, payment status, and more.

---

## Notification Types

| Type | Description |
|------|-------------|
| `BOOKING_CREATED` | New booking request received |
| `BOOKING_ACCEPTED` | Booking was accepted by provider |
| `BOOKING_REJECTED` | Booking was rejected by provider |
| `BOOKING_CANCELLED` | Booking was cancelled |
| `BOOKING_STARTED` | Service has started |
| `BOOKING_COMPLETED` | Service completed |
| `PAYMENT_RECEIVED` | Payment received successfully |
| `PAYMENT_FAILED` | Payment failed |
| `REFUND_PROCESSED` | Refund has been processed |
| `REVIEW_RECEIVED` | New review received |
| `REVIEW_RESPONSE` | Provider responded to review |
| `VERIFICATION_APPROVED` | Provider verification approved |
| `VERIFICATION_REJECTED` | Provider verification rejected |
| `SERVICE_APPROVED` | Service listing approved |
| `SERVICE_REJECTED` | Service listing rejected |
| `SERVICE_SUSPENDED` | Service listing suspended |
| `DISPUTE_OPENED` | New dispute opened |
| `DISPUTE_UPDATED` | Dispute status updated |
| `DISPUTE_RESOLVED` | Dispute resolved |
| `NEW_MESSAGE` | New chat message received |
| `ACCOUNT_SUSPENDED` | Account suspended |
| `ACCOUNT_ACTIVATED` | Account activated |
| `SYSTEM_ANNOUNCEMENT` | System-wide announcement |

---

## 1. Get My Notifications

**What this API does:** Returns a paginated list of the user's notifications with optional filtering.

### Request

```graphql
query MyNotifications($filters: NotificationFiltersInput, $pagination: PaginationInput) {
  myNotifications(filters: $filters, pagination: $pagination) {
    notifications {
      id
      userId
      type
      title
      message
      entityType
      entityId
      metadata
      isRead
      readAt
      createdAt
    }
    total
    page
    limit
    totalPages
    hasNextPage
    hasPreviousPage
  }
}
```

### Variables

```json
{
  "filters": {
    "type": "BOOKING_CREATED",
    "isRead": false
  },
  "pagination": {
    "page": 1,
    "limit": 20
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "myNotifications": {
      "notifications": [
        {
          "id": "notif_123",
          "userId": "user_456",
          "type": "BOOKING_ACCEPTED",
          "title": "Booking Accepted",
          "message": "CleanPro Services has accepted your booking for Deep Cleaning",
          "entityType": "booking",
          "entityId": "booking_789",
          "metadata": null,
          "isRead": false,
          "readAt": null,
          "createdAt": "2026-03-14T10:30:00Z"
        }
      ],
      "total": 15,
      "page": 1,
      "limit": 20,
      "totalPages": 1,
      "hasNextPage": false,
      "hasPreviousPage": false
    }
  }
}
```

---

## 2. Get Unread Notification Count

**What this API does:** Returns the count of unread notifications for badge display.

### Request

```graphql
query UnreadNotificationCount {
  unreadNotificationCount {
    count
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "unreadNotificationCount": {
      "count": 8
    }
  }
}
```

---

## 3. Get Notification Statistics

**What this API does:** Returns detailed statistics about the user's notifications.

### Request

```graphql
query NotificationStats {
  notificationStats {
    total
    unread
    read
    byType
  }
}
```

### Success Response (200)

```json
{
  "data": {
    "notificationStats": {
      "total": 50,
      "unread": 8,
      "read": 42,
      "byType": "{\"BOOKING_ACCEPTED\": 10, \"NEW_MESSAGE\": 25, \"REVIEW_RECEIVED\": 15}"
    }
  }
}
```

---

## 4. Mark Notification as Read

**What this API does:** Marks a single notification as read.

### Request

```graphql
mutation MarkNotificationAsRead($notificationId: ID!) {
  markNotificationAsRead(notificationId: $notificationId) {
    id
    isRead
    readAt
  }
}
```

### Variables

```json
{
  "notificationId": "notif_123"
}
```

---

## 5. Mark All Notifications as Read

**What this API does:** Marks all unread notifications as read.

### Request

```graphql
mutation MarkAllNotificationsAsRead {
  markAllNotificationsAsRead {
    success
    message
  }
}
```

---

## 6. Delete Notification

**What this API does:** Deletes a single notification.

### Request

```graphql
mutation DeleteNotification($notificationId: ID!) {
  deleteNotification(notificationId: $notificationId) {
    success
    message
  }
}
```

---

## 7. Delete All Read Notifications

**What this API does:** Deletes all notifications that have been read.

### Request

```graphql
mutation DeleteReadNotifications {
  deleteReadNotifications {
    success
    message
  }
}
```

---

## 8. Send System Announcement (Admin Only)

**What this API does:** Sends a system-wide announcement to all users or specific roles.

### Request

```graphql
mutation SendSystemAnnouncement($input: SendAnnouncementInput!) {
  sendSystemAnnouncement(input: $input) {
    success
    message
  }
}
```

### Variables

```json
{
  "input": {
    "title": "Platform Maintenance",
    "message": "The platform will be under maintenance on March 15th from 2-4 AM.",
    "targetRoles": ["SERVICE_USER", "SERVICE_PROVIDER"]
  }
}
```

**Note:** If `targetRoles` is omitted, the announcement is sent to all active users.

---

# Real-Time Messaging Integration

For real-time updates, implement polling or use WebSocket subscriptions (if added later).

## Polling Strategy

```javascript
// Poll for new messages every 5 seconds when conversation is open
const pollMessages = (conversationId) => {
  return setInterval(async () => {
    const { data } = await client.query({
      query: CONVERSATION_MESSAGES,
      variables: { conversationId, pagination: { page: 1, limit: 10 } },
      fetchPolicy: 'network-only'
    });
    // Update UI with new messages
  }, 5000);
};

// Poll for unread counts every 30 seconds
const pollUnreadCounts = () => {
  return setInterval(async () => {
    const [messages, notifications] = await Promise.all([
      client.query({ query: UNREAD_MESSAGE_COUNT, fetchPolicy: 'network-only' }),
      client.query({ query: UNREAD_NOTIFICATION_COUNT, fetchPolicy: 'network-only' })
    ]);
    // Update badge counts
  }, 30000);
};
```

## Push Notifications (OneSignal)

Push notifications are implemented using **OneSignal**. The backend provides APIs to register devices and the server sends push notifications automatically for key events.

### Setup (React Native / Expo)

```bash
# Install OneSignal SDK
npx expo install onesignal-expo-plugin react-native-onesignal
```

### Initialize OneSignal

```typescript
// App.tsx or app entry point
import OneSignal from 'react-native-onesignal';

// Initialize with your OneSignal App ID
OneSignal.setAppId('YOUR_ONESIGNAL_APP_ID');

// Request push notification permission (iOS)
OneSignal.promptForPushNotificationsWithUserResponse();

// Get player ID when available
OneSignal.addSubscriptionObserver(event => {
  if (event.to.userId) {
    // Register with backend
    registerPushToken(event.to.userId);
  }
});

// Handle notification opened
OneSignal.setNotificationOpenedHandler(notification => {
  const data = notification.notification.additionalData;
  
  switch (data?.type) {
    case 'BOOKING':
      navigation.navigate('BookingDetails', { id: data.bookingId });
      break;
    case 'MESSAGE':
      navigation.navigate('Chat', { conversationId: data.conversationId });
      break;
    case 'REVIEW':
      navigation.navigate('Reviews');
      break;
    case 'VERIFICATION':
      navigation.navigate('ProviderProfile');
      break;
  }
});
```

### Register Device with Backend

```graphql
mutation RegisterPushToken($playerId: String!) {
  registerPushToken(playerId: $playerId) {
    success
    message
    pushEnabled
  }
}
```

```typescript
// Call after user logs in and OneSignal provides playerId
const registerPushToken = async (playerId: string) => {
  try {
    await client.mutate({
      mutation: REGISTER_PUSH_TOKEN,
      variables: { playerId }
    });
  } catch (error) {
    console.error('Failed to register push token:', error);
  }
};
```

### Unregister on Logout

```graphql
mutation UnregisterPushToken {
  unregisterPushToken {
    success
    message
    pushEnabled
  }
}
```

```typescript
const logout = async () => {
  // Unregister push token
  await client.mutate({ mutation: UNREGISTER_PUSH_TOKEN });
  
  // Clear tokens
  await AsyncStorage.multiRemove(['accessToken', 'refreshToken']);
  
  // Navigate to login
  navigation.reset({ routes: [{ name: 'Login' }] });
};
```

### Toggle Push Notifications (Settings)

```graphql
mutation UpdatePushPreference($enabled: Boolean!) {
  updatePushPreference(enabled: $enabled) {
    success
    message
    pushEnabled
  }
}
```

```typescript
// Settings screen toggle
const PushNotificationToggle = () => {
  const [enabled, setEnabled] = useState(true);

  const togglePush = async (value: boolean) => {
    await client.mutate({
      mutation: UPDATE_PUSH_PREFERENCE,
      variables: { enabled: value }
    });
    setEnabled(value);
  };

  return (
    <Switch value={enabled} onValueChange={togglePush} />
  );
};
```

### Automatic Push Events

The backend automatically sends push notifications for:

| Event | Title | When |
|-------|-------|------|
| New Booking | "New Booking Request" | Provider receives booking |
| Booking Accepted | "Booking Accepted! 🎉" | User's booking is accepted |
| Booking Rejected | "Booking Update" | User's booking is rejected |
| Booking Completed | "Booking Completed" | Service is marked complete |
| Booking Cancelled | "Booking Cancelled" | Booking is cancelled |
| New Message | "New message from {name}" | User receives a message |
| New Review | "New Review Received ⭐" | Provider gets a review |
| Verification Approved | "Verification Approved! 🎉" | Provider is verified |
| Verification Rejected | "Verification Update" | Provider verification failed |

### iOS Badge Management

The backend supports iOS badge count updates:
- Badge is updated with `ios_badgeType` and `ios_badgeCount`
- Silent pushes can update badge without showing notification

---

# Token Management

## Access Token
- **Expiry:** 7 days
- **Usage:** Include in Authorization header for all authenticated requests
- **Storage:** localStorage (web), AsyncStorage (React Native), SharedPreferences (Android), Keychain (iOS)

## Refresh Token
- **Expiry:** 30 days
- **Usage:** Get new access token when current one expires
- **Storage:** Same as access token, but more securely if possible

## Token Refresh Flow

```javascript
// Pseudo-code for token refresh
async function makeAuthenticatedRequest(query, variables) {
  try {
    return await graphqlRequest(query, variables);
  } catch (error) {
    if (error.extensions?.code === 'UNAUTHENTICATED') {
      // Try to refresh token
      const refreshToken = getRefreshToken();
      const { data } = await refreshTokenMutation(refreshToken);
      
      // Save new access token
      saveAccessToken(data.refreshToken.accessToken);
      
      // Retry original request
      return await graphqlRequest(query, variables);
    }
    throw error;
  }
}
```

---

# Security Notes

1. **Always use HTTPS in production**
2. **Store tokens securely** (not in cookies accessible to JS)
3. **Validate all inputs on frontend** before sending
4. **Handle token expiry gracefully** with refresh flow
5. **Clear tokens on logout**
6. **Implement rate limiting on frontend** to prevent abuse

---

# Real-time WebSocket Integration

EasyKonnect provides real-time functionality through Socket.io WebSockets. This enables instant messaging, typing indicators, presence detection, and real-time notifications.

## Server Endpoints

- **Development**: `ws://localhost:3000`
- **Production**: `wss://your-production-server.com`

## Installation

```bash
# React / React Native
npm install socket.io-client

# Flutter
flutter pub add socket_io_client

# iOS
pod 'Socket.IO-Client-Swift'

# Android (Gradle)
implementation 'io.socket:socket.io-client:2.0.0'
```

---

## Connection Setup

### JavaScript / TypeScript

```typescript
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'wss://your-server.com';

// Create socket connection with authentication
const socket: Socket = io(SOCKET_URL, {
  auth: {
    token: 'YOUR_ACCESS_TOKEN' // Same JWT used for GraphQL
  },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

// Connection event handlers
socket.on('connect', () => {
  console.log('Connected to WebSocket server');
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error.message);
  // Handle authentication errors
  if (error.message === 'Authentication required') {
    // Redirect to login
  }
});
```

### React Native

```typescript
import { io } from 'socket.io-client';

const socket = io('wss://your-server.com', {
  auth: { token: accessToken },
  transports: ['websocket'], // Use WebSocket only for React Native
});
```

### Flutter

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

IO.Socket socket = IO.io('wss://your-server.com', 
  IO.OptionBuilder()
    .setTransports(['websocket'])
    .setAuth({'token': accessToken})
    .enableAutoConnect()
    .build()
);

socket.onConnect((_) => print('Connected'));
socket.onDisconnect((_) => print('Disconnected'));
```

---

## Socket Events Reference

### Emitting Events (Client → Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `conversation:join` | `{ conversationId: string }` | Join a conversation room |
| `conversation:leave` | `{ conversationId: string }` | Leave a conversation room |
| `message:send` | `{ conversationId, content, attachments? }` | Send a message |
| `typing:start` | `{ conversationId }` | Start typing indicator |
| `typing:stop` | `{ conversationId }` | Stop typing indicator |
| `messages:read` | `{ conversationId, messageIds }` | Mark messages as read |
| `heartbeat` | - | Keep connection alive |
| `presence:check` | `{ userIds: string[] }` | Check online status |

### Listening Events (Server → Client)

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `MessagePayload` | New message received |
| `message:sent` | `{ tempId, messageId }` | Message sent confirmation |
| `typing:update` | `{ userId, userName, conversationId, isTyping }` | Typing indicator update |
| `messages:read` | `{ conversationId, messageIds, readBy, readAt }` | Read receipt |
| `notification:new` | `NotificationPayload` | New notification |
| `user:online` | `{ userId, userName }` | User came online |
| `user:offline` | `{ userId, userName, lastSeen }` | User went offline |
| `user:joined` | `{ userId, userName, conversationId }` | User joined conversation |
| `user:left` | `{ userId, userName, conversationId }` | User left conversation |
| `presence:status` | `Record<string, boolean>` | Online status response |
| `error` | `{ message: string }` | Error message |

---

## Real-time Messaging Implementation

### Joining a Conversation

```typescript
// When user opens a chat screen
function openChat(conversationId: string) {
  socket.emit('conversation:join', { conversationId });
}

// When user leaves chat screen
function closeChat(conversationId: string) {
  socket.emit('conversation:leave', { conversationId });
}
```

### Sending Messages

```typescript
// Generate temporary ID for optimistic updates
const tempId = `temp_${Date.now()}`;

// Send message
socket.emit('message:send', {
  conversationId: 'conv123',
  content: 'Hello!',
  attachments: ['https://cloudinary.com/image.jpg'], // Optional
});

// Listen for sent confirmation
socket.on('message:sent', ({ tempId, messageId }) => {
  // Replace temporary message with confirmed one
  updateMessageId(tempId, messageId);
});
```

### Receiving Messages

```typescript
socket.on('message:new', (message) => {
  // message = {
  //   id: 'msg123',
  //   conversationId: 'conv456',
  //   senderId: 'user789',
  //   senderRole: 'SERVICE_USER',
  //   senderName: 'John',
  //   content: 'Hello!',
  //   attachments: [],
  //   status: 'SENT',
  //   createdAt: '2024-01-15T10:30:00Z'
  // }
  
  // Add to message list
  addMessage(message);
  
  // Play notification sound if not current conversation
  if (message.conversationId !== currentConversationId) {
    playNotificationSound();
  }
});
```

### Typing Indicators

```typescript
// When user starts typing
let typingTimeout: NodeJS.Timeout;

function onInputChange(text: string) {
  // Send typing start
  socket.emit('typing:start', { conversationId: currentConversationId });
  
  // Clear previous timeout
  clearTimeout(typingTimeout);
  
  // Stop typing after 2 seconds of inactivity
  typingTimeout = setTimeout(() => {
    socket.emit('typing:stop', { conversationId: currentConversationId });
  }, 2000);
}

// Listen for others typing
socket.on('typing:update', ({ userId, userName, conversationId, isTyping }) => {
  if (conversationId === currentConversationId && userId !== currentUserId) {
    if (isTyping) {
      showTypingIndicator(userName);
    } else {
      hideTypingIndicator(userName);
    }
  }
});
```

### Read Receipts

```typescript
// When user views messages
function markMessagesAsRead(conversationId: string, messageIds: string[]) {
  socket.emit('messages:read', { conversationId, messageIds });
}

// Listen for read receipts
socket.on('messages:read', ({ conversationId, messageIds, readBy, readAt }) => {
  // Update message status to 'READ'
  updateMessagesStatus(messageIds, 'READ', readAt);
});
```

---

## Presence System

### Heartbeat (Keep Connection Alive)

```typescript
// Send heartbeat every 60 seconds
setInterval(() => {
  if (socket.connected) {
    socket.emit('heartbeat');
  }
}, 60000);
```

### Check Online Status

```typescript
// Check if specific users are online
socket.emit('presence:check', { 
  userIds: ['user1', 'user2', 'user3'] 
});

socket.on('presence:status', (statuses) => {
  // statuses = { user1: true, user2: false, user3: true }
  updateOnlineStatuses(statuses);
});
```

### Listen for Online/Offline Events

```typescript
socket.on('user:online', ({ userId, userName }) => {
  updateUserStatus(userId, 'online');
});

socket.on('user:offline', ({ userId, userName, lastSeen }) => {
  updateUserStatus(userId, 'offline', lastSeen);
});
```

---

## Real-time Notifications

```typescript
// Listen for new notifications
socket.on('notification:new', (notification) => {
  // notification = {
  //   id: 'notif123',
  //   type: 'NEW_MESSAGE',
  //   title: 'New message from John',
  //   message: 'Hello! How are you?',
  //   entityType: 'Conversation',
  //   entityId: 'conv456',
  //   isRead: false,
  //   createdAt: '2024-01-15T10:30:00Z'
  // }
  
  // Show in-app notification
  showNotificationToast(notification);
  
  // Update notification badge count
  incrementNotificationCount();
});
```

---

## React Context Example

```typescript
// SocketContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  onlineUsers: Set<string>;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  onlineUsers: new Set(),
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { accessToken, isAuthenticated } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      return;
    }

    const newSocket = io(process.env.NEXT_PUBLIC_WS_URL!, {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('user:online', ({ userId }) => {
      setOnlineUsers(prev => new Set([...prev, userId]));
    });

    newSocket.on('user:offline', ({ userId }) => {
      setOnlineUsers(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [isAuthenticated, accessToken]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, onlineUsers }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
```

---

## Error Handling

```typescript
socket.on('error', ({ message }) => {
  console.error('Socket error:', message);
  
  // Handle specific errors
  switch (message) {
    case 'Conversation not found or access denied':
      showErrorToast('Unable to access this conversation');
      break;
    case 'Failed to send message':
      showErrorToast('Message failed to send. Please try again.');
      break;
    default:
      showErrorToast('Something went wrong');
  }
});

socket.on('connect_error', (error) => {
  if (error.message === 'Authentication required' || 
      error.message === 'Invalid token') {
    // Token expired, redirect to login
    logout();
  }
});
```

---

## Reconnection Handling

```typescript
socket.on('reconnect', (attemptNumber) => {
  console.log('Reconnected after', attemptNumber, 'attempts');
  
  // Re-join active conversation
  if (currentConversationId) {
    socket.emit('conversation:join', { 
      conversationId: currentConversationId 
    });
  }
});

socket.on('reconnect_error', (error) => {
  console.error('Reconnection error:', error);
});

socket.on('reconnect_failed', () => {
  console.error('Failed to reconnect');
  showReconnectPrompt();
});
```

---

## Hybrid Approach: WebSocket + GraphQL

For best results, use WebSocket for real-time updates and GraphQL for data fetching:

```typescript
// Initial load: Use GraphQL
const { data } = await graphql.query({
  query: GET_CONVERSATIONS,
});

// Real-time updates: Use WebSocket
socket.on('message:new', (message) => {
  // Update local state or Apollo cache
  cache.modify({
    fields: {
      getConversations(existing) {
        // Update conversation with new message
      }
    }
  });
});

// Sending messages: Can use either
// Option 1: GraphQL (with response validation)
await graphql.mutate({
  mutation: SEND_MESSAGE,
  variables: { conversationId, content }
});

// Option 2: WebSocket (faster, real-time)
socket.emit('message:send', { conversationId, content });
```

---

## Production Deployment Notes

### Using Custom Server (Recommended)

```bash
# Build the custom server
npm run build:server

# Start with WebSocket support
npm run start:ws
```

### Environment Variables

```env
# Required for WebSocket
REDIS_URL=redis://your-redis-server:6379
SOCKET_CORS_ORIGIN=https://your-frontend.com,https://admin.your-frontend.com
```

### Scaling with Redis

The WebSocket server uses Redis Pub/Sub for horizontal scaling. This means you can run multiple server instances behind a load balancer, and all clients will receive real-time updates regardless of which server they're connected to.

```
[Client A] ──► [Server 1] ──┐
                            ├──► [Redis Pub/Sub] ──► All servers sync
[Client B] ──► [Server 2] ──┘
```

---

## Mobile Push Notifications (OneSignal)

Push notifications are fully integrated using **OneSignal**. The system handles both online (WebSocket) and offline (push) scenarios:

### How It Works

1. **User logs in** → App registers OneSignal player ID with backend (`registerPushToken`)
2. **Event occurs** (new booking, message, etc.) → Backend sends push via OneSignal
3. **User taps notification** → App handles deep link to relevant screen

### Push + WebSocket Integration

| User State | Notification Delivery |
|------------|----------------------|
| App in foreground | WebSocket real-time event |
| App in background | Push notification |
| App closed | Push notification |
| Push disabled | Database notification only (shown on next app open) |

### Silent/Background Push (iOS)

For background data sync without user-visible notification:

```typescript
// Backend sends silent push with content_available: true
// App receives in background handler
OneSignal.setNotificationWillShowInForegroundHandler(event => {
  const notification = event.getNotification();
  
  if (notification.additionalData?.silent) {
    // Handle silently - sync data without showing
    event.complete(null);
    syncDataInBackground();
  } else {
    // Show notification normally
    event.complete(notification);
  }
});
```

### iOS Badge Count

Badge count is automatically managed by the backend:
- New notifications increment the badge
- User can clear badge by marking notifications as read

---

## Testing WebSocket Connection

You can test the WebSocket connection using a tool like [Socket.io Client Tool](https://amritb.github.io/socketio-client-tool/) or programmatically:

```typescript
// Quick test
const socket = io('wss://your-server.com', {
  auth: { token: 'YOUR_TOKEN' }
});

socket.on('connect', () => {
  console.log('✅ Connected');
  
  // Test joining a conversation
  socket.emit('conversation:join', { conversationId: 'test123' });
});

socket.on('error', (err) => {
  console.log('❌ Error:', err);
});
```

---

# Browse Providers API

The browse/discovery API lets users find verified service providers without being logged in. It supports rich filtering, sorting, and geolocation.

---

## Browse All Providers

```graphql
query BrowseProviders($input: BrowseProvidersInput) {
  providers(input: $input) {
    items {
      id
      businessName
      businessDescription
      verificationStatus
      city
      state
      country
      images
      averageRating
      totalReviews
      likeCount
      categories
      user {
        id
        firstName
        lastName
        profilePhoto
      }
      createdAt
    }
    pagination {
      page
      limit
      total
      totalPages
      hasNext
      hasPrev
    }
  }
}
```

### Variables

```json
{
  "input": {
    "filters": {
      "city": "Lagos",
      "state": "Lagos",
      "categoryId": "cat_abc123",
      "verifiedOnly": true,
      "minRating": 4.0
    },
    "sortBy": "RATING_DESC",
    "pagination": { "page": 1, "limit": 10 }
  }
}
```

### Sort Options (`ProviderSortBy`)

| Value | Description |
|-------|-------------|
| `RATING_DESC` | Highest average rating first |
| `POPULARITY_DESC` | Most likes first |
| `NEWEST` | Most recently joined first (default) |
| `NAME_ASC` | Alphabetical by business name |

### Filter Options (`ProviderFiltersInput`)

| Field | Type | Description |
|-------|------|-------------|
| `city` | String | Filter by city (case-insensitive) |
| `state` | String | Filter by state (case-insensitive) |
| `country` | String | Filter by country (case-insensitive) |
| `categoryId` | ID | Filter by service category |
| `verifiedOnly` | Boolean | Only show verified providers (default: `true`) |
| `minRating` | Float | Minimum average rating (e.g. `4.0`) |

### Success Response

```json
{
  "data": {
    "providers": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439011",
          "businessName": "Sparkle Cleaning Co.",
          "averageRating": 4.8,
          "totalReviews": 32,
          "likeCount": 148,
          "categories": ["Cleaning", "Laundry"],
          "city": "Lagos",
          "state": "Lagos",
          "verificationStatus": "VERIFIED"
        }
      ],
      "pagination": {
        "page": 1,
        "limit": 10,
        "total": 45,
        "totalPages": 5,
        "hasNext": true,
        "hasPrev": false
      }
    }
  }
}
```

---

## Get Provider Public Profile

Returns the full public profile of a single provider including their active services.

```graphql
query GetProviderProfile($providerId: ID!) {
  providerProfile(providerId: $providerId) {
    id
    businessName
    businessDescription
    verificationStatus
    address
    city
    state
    country
    latitude
    longitude
    images
    averageRating
    totalReviews
    likeCount
    categories
    user {
      id
      firstName
      lastName
      profilePhoto
    }
    activeServices {
      id
      name
      price
      duration
      images
      category {
        id
        name
        slug
      }
    }
    createdAt
  }
}
```

### Variables

```json
{
  "providerId": "507f1f77bcf86cd799439011"
}
```

### Success Response

```json
{
  "data": {
    "providerProfile": {
      "id": "507f1f77bcf86cd799439011",
      "businessName": "Sparkle Cleaning Co.",
      "averageRating": 4.8,
      "totalReviews": 32,
      "likeCount": 148,
      "activeServices": [
        {
          "id": "svc_abc",
          "name": "Deep Cleaning",
          "price": 8000,
          "duration": 180,
          "images": ["https://..."],
          "category": { "id": "cat1", "name": "Cleaning", "slug": "cleaning" }
        }
      ]
    }
  }
}
```

### Error Responses

| Code | Message | Description |
|------|---------|-------------|
| `NOT_FOUND` | Provider not found | Invalid `providerId` |

---

# Nearby Providers API

Find service providers near a specific GPS coordinate using the Haversine formula.

> 🔓 **Public endpoint** — no authentication required.  
> 📍 Latitude/longitude must be WGS-84 decimal degrees (standard GPS format).

---

## Get Nearby Providers

```graphql
query NearbyProviders($input: NearbyProvidersInput!) {
  nearbyProviders(input: $input) {
    items {
      id
      businessName
      businessDescription
      verificationStatus
      city
      state
      country
      images
      averageRating
      totalReviews
      likeCount
      distanceKm
      categories
      user {
        id
        firstName
        lastName
        profilePhoto
      }
    }
    pagination {
      page
      limit
      total
      totalPages
      hasNext
      hasPrev
    }
    radiusKm
    searchLocation {
      latitude
      longitude
    }
  }
}
```

### Variables

```json
{
  "input": {
    "latitude": 6.5244,
    "longitude": 3.3792,
    "radiusKm": 10,
    "filters": {
      "categoryId": "cat_abc123",
      "minRating": 3.5
    },
    "sortBy": "RATING_DESC",
    "pagination": { "page": 1, "limit": 20 }
  }
}
```

### Field Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `latitude` | Float | ✅ | User's current latitude |
| `longitude` | Float | ✅ | User's current longitude |
| `radiusKm` | Float | ❌ | Search radius in km (default: `25`, max: `100`) |
| `filters` | ProviderFiltersInput | ❌ | Same filters as `providers` query |
| `sortBy` | ProviderSortBy | ❌ | Default: `RATING_DESC` for nearby |
| `pagination` | PaginationInput | ❌ | Default: page 1, limit 10 |

### Sort Behaviour for Nearby

| `sortBy` Value | Behaviour |
|----------------|-----------|
| `RATING_DESC` | Highest rated providers first (default) |
| `POPULARITY_DESC` | Most liked first |
| `NAME_ASC` | Alphabetical |
| `NEWEST` | **Distance** (nearest first — NEWEST is repurposed for proximity) |

### Success Response

```json
{
  "data": {
    "nearbyProviders": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439011",
          "businessName": "Sparkle Cleaning Co.",
          "averageRating": 4.8,
          "likeCount": 148,
          "distanceKm": 2.3,
          "city": "Lagos"
        }
      ],
      "pagination": {
        "page": 1,
        "limit": 20,
        "total": 7,
        "totalPages": 1,
        "hasNext": false,
        "hasPrev": false
      },
      "radiusKm": 10,
      "searchLocation": {
        "latitude": 6.5244,
        "longitude": 3.3792
      }
    }
  }
}
```

### Notes

- Providers without `latitude`/`longitude` set are automatically **excluded** from nearby results.
- `distanceKm` is accurate to 1 decimal place (e.g. `3.7`).
- The `radiusKm` field in the response reflects the clamped value (e.g. if you pass `9999`, you get `100`).
- For mobile apps, use the device GPS coordinates (`navigator.geolocation.getCurrentPosition`).

---

# Google Maps Integration

EasyKonect uses Google Maps Platform APIs for geolocation features. This section explains how to integrate these on the frontend.

---

## APIs Used

| API | Purpose | Where Used |
|-----|---------|------------|
| **Geocoding API** | Convert addresses → lat/lng coordinates | Backend: when provider saves address |
| **Distance Matrix API** | Calculate distances between points | Backend: `nearbyProviders` query |
| **Places Autocomplete** | Address suggestions as user types | Frontend: address input fields |

---

## Frontend: Places Autocomplete

The Places Autocomplete API provides address suggestions as users type. This is the **recommended approach** for address inputs (provider onboarding, user location selection).

### Setup (Web)

1. Load the Google Maps JavaScript SDK:

```html
<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_GOOGLE_MAPS_API_KEY&libraries=places"></script>
```

2. Initialize autocomplete on an input field:

```javascript
// Initialize autocomplete
const input = document.getElementById('address-input');
const autocomplete = new google.maps.places.Autocomplete(input, {
  types: ['address'],
  componentRestrictions: { country: 'ng' } // Restrict to Nigeria
});

// Handle place selection
autocomplete.addListener('place_changed', () => {
  const place = autocomplete.getPlace();
  
  if (!place.geometry) {
    console.error('No geometry for this place');
    return;
  }
  
  const locationData = {
    address: place.formatted_address,
    latitude: place.geometry.location.lat(),
    longitude: place.geometry.location.lng(),
    city: extractComponent(place, 'locality'),
    state: extractComponent(place, 'administrative_area_level_1'),
    country: extractComponent(place, 'country'),
  };
  
  console.log('Selected location:', locationData);
  // Use this data in your becomeProvider or updateProviderProfile mutation
});

// Helper to extract address components
function extractComponent(place, type) {
  const component = place.address_components?.find(c => c.types.includes(type));
  return component?.long_name || '';
}
```

### Setup (React)

```tsx
import { useEffect, useRef, useState } from 'react';

interface LocationData {
  address: string;
  latitude: number;
  longitude: number;
  city: string;
  state: string;
  country: string;
}

interface AddressAutocompleteProps {
  onSelect: (location: LocationData) => void;
  placeholder?: string;
}

export function AddressAutocomplete({ onSelect, placeholder = 'Enter address' }: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!inputRef.current || !window.google) return;

    const autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'ng' },
    });

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry?.location) return;

      const getComponent = (type: string) => {
        const component = place.address_components?.find(c => c.types.includes(type));
        return component?.long_name || '';
      };

      onSelect({
        address: place.formatted_address || '',
        latitude: place.geometry.location.lat(),
        longitude: place.geometry.location.lng(),
        city: getComponent('locality'),
        state: getComponent('administrative_area_level_1'),
        country: getComponent('country'),
      });
      
      setValue(place.formatted_address || '');
    });

    return () => {
      google.maps.event.clearInstanceListeners(autocomplete);
    };
  }, [onSelect]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      className="address-input"
    />
  );
}
```

### Setup (React Native)

For React Native, use `react-native-google-places-autocomplete`:

```bash
npm install react-native-google-places-autocomplete
```

```tsx
import { GooglePlacesAutocomplete } from 'react-native-google-places-autocomplete';

export function AddressInput({ onSelect }) {
  return (
    <GooglePlacesAutocomplete
      placeholder="Enter your address"
      onPress={(data, details = null) => {
        if (!details?.geometry?.location) return;
        
        onSelect({
          address: data.description,
          latitude: details.geometry.location.lat,
          longitude: details.geometry.location.lng,
          city: extractComponent(details, 'locality'),
          state: extractComponent(details, 'administrative_area_level_1'),
          country: extractComponent(details, 'country'),
        });
      }}
      query={{
        key: 'YOUR_GOOGLE_MAPS_API_KEY',
        language: 'en',
        components: 'country:ng',
      }}
      fetchDetails={true}
      styles={{
        textInput: { height: 44, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12 },
      }}
    />
  );
}

function extractComponent(details, type) {
  const component = details.address_components?.find(c => c.types.includes(type));
  return component?.long_name || '';
}
```

### Setup (Flutter)

For Flutter, use `google_places_flutter`:

```yaml
# pubspec.yaml
dependencies:
  google_places_flutter: ^2.0.5
```

```dart
import 'package:google_places_flutter/google_places_flutter.dart';
import 'package:google_places_flutter/model/prediction.dart';

class AddressInput extends StatelessWidget {
  final Function(Map<String, dynamic>) onSelect;
  final TextEditingController controller = TextEditingController();

  AddressInput({required this.onSelect});

  @override
  Widget build(BuildContext context) {
    return GooglePlaceAutoCompleteTextField(
      textEditingController: controller,
      googleAPIKey: "YOUR_GOOGLE_MAPS_API_KEY",
      inputDecoration: InputDecoration(
        hintText: "Enter your address",
        border: OutlineInputBorder(),
      ),
      countries: ["ng"], // Restrict to Nigeria
      isLatLngRequired: true,
      getPlaceDetailWithLatLng: (Prediction prediction) {
        onSelect({
          'address': prediction.description,
          'latitude': double.parse(prediction.lat ?? '0'),
          'longitude': double.parse(prediction.lng ?? '0'),
        });
      },
      itemClick: (Prediction prediction) {
        controller.text = prediction.description ?? '';
        controller.selection = TextSelection.fromPosition(
          TextPosition(offset: prediction.description?.length ?? 0),
        );
      },
    );
  }
}
```

---

## Get User's Current Location

For the `nearbyProviders` query, you need the user's current GPS coordinates.

### Web (Browser)

```javascript
async function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy, // meters
        });
      },
      (error) => {
        switch (error.code) {
          case error.PERMISSION_DENIED:
            reject(new Error('Location permission denied'));
            break;
          case error.POSITION_UNAVAILABLE:
            reject(new Error('Location unavailable'));
            break;
          case error.TIMEOUT:
            reject(new Error('Location request timed out'));
            break;
          default:
            reject(new Error('Unknown location error'));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000, // Cache for 1 minute
      }
    );
  });
}

// Usage with nearbyProviders query
async function findNearbyProviders(apolloClient) {
  try {
    const location = await getCurrentLocation();
    
    const { data } = await apolloClient.query({
      query: NEARBY_PROVIDERS_QUERY,
      variables: {
        input: {
          latitude: location.latitude,
          longitude: location.longitude,
          radiusKm: 25,
        },
      },
    });
    
    return data.nearbyProviders;
  } catch (error) {
    console.error('Failed to get nearby providers:', error);
    // Fall back to browse providers without location
  }
}
```

### React Native

```tsx
import Geolocation from '@react-native-community/geolocation';
// or: import * as Location from 'expo-location'; // for Expo

async function getCurrentLocation() {
  // Request permission first
  const permission = await Geolocation.requestAuthorization('whenInUse');
  
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}
```

### Flutter

```dart
import 'package:geolocator/geolocator.dart';

Future<Position> getCurrentLocation() async {
  bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
  if (!serviceEnabled) {
    throw Exception('Location services are disabled');
  }

  LocationPermission permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied) {
      throw Exception('Location permission denied');
    }
  }

  return await Geolocator.getCurrentPosition(
    desiredAccuracy: LocationAccuracy.high,
  );
}
```

---

## Complete Example: Provider Onboarding with Address Autocomplete

```tsx
import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { AddressAutocomplete } from './AddressAutocomplete';

const BECOME_PROVIDER = gql`
  mutation BecomeProvider($input: BecomeProviderInput!) {
    becomeProvider(input: $input) {
      user {
        id
        role
        providerProfile {
          id
          businessName
          verificationStatus
        }
      }
      accessToken
      refreshToken
    }
  }
`;

export function ProviderOnboardingForm() {
  const [formData, setFormData] = useState({
    businessName: '',
    businessDescription: '',
    address: '',
    city: '',
    state: '',
    country: 'Nigeria',
    latitude: null as number | null,
    longitude: null as number | null,
  });

  const [becomeProvider, { loading }] = useMutation(BECOME_PROVIDER);

  const handleAddressSelect = (location: LocationData) => {
    setFormData(prev => ({
      ...prev,
      address: location.address,
      city: location.city,
      state: location.state,
      country: location.country,
      latitude: location.latitude,
      longitude: location.longitude,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const { data } = await becomeProvider({
        variables: {
          input: {
            businessName: formData.businessName,
            businessDescription: formData.businessDescription,
            address: formData.address,
            city: formData.city,
            state: formData.state,
            country: formData.country,
            latitude: formData.latitude,
            longitude: formData.longitude,
          },
        },
      });

      // ⚠️ CRITICAL: Replace tokens immediately!
      const { accessToken, refreshToken } = data.becomeProvider;
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      
      // Update Apollo Client auth header
      // Now you can call uploadProviderDocuments, etc.
      
    } catch (error) {
      console.error('Failed to become provider:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Business Name"
        value={formData.businessName}
        onChange={(e) => setFormData(prev => ({ ...prev, businessName: e.target.value }))}
        required
      />
      
      <textarea
        placeholder="Business Description"
        value={formData.businessDescription}
        onChange={(e) => setFormData(prev => ({ ...prev, businessDescription: e.target.value }))}
      />
      
      {/* Address autocomplete with Google Places */}
      <AddressAutocomplete
        onSelect={handleAddressSelect}
        placeholder="Start typing your business address..."
      />
      
      {formData.latitude && (
        <p className="text-sm text-gray-500">
          📍 Location: {formData.latitude.toFixed(4)}, {formData.longitude?.toFixed(4)}
        </p>
      )}
      
      <button type="submit" disabled={loading || !formData.latitude}>
        {loading ? 'Processing...' : 'Become a Provider'}
      </button>
    </form>
  );
}
```

---

## Environment Variables

Add to your frontend `.env`:

```bash
# .env.local (Next.js) or .env (React/Vite)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your-api-key-here
# or
VITE_GOOGLE_MAPS_API_KEY=your-api-key-here
```

⚠️ **Security Note**: The Google Maps API key used on the frontend should be restricted:
- In Google Cloud Console → Credentials → your API key
- Set **Application restrictions** to "HTTP referrers" 
- Add your domains: `localhost:*`, `yourdomain.com/*`, `*.yourdomain.com/*`
- Set **API restrictions** to only: Places API (frontend only needs this)

---

# Provider Profile — Own Profile

> 🔐 Requires authentication + `SERVICE_PROVIDER` role.

Providers can fetch their own full profile — including their services list — separately from the `me` query. The `me` query returns basic identity; `myProviderProfile` returns the complete provider record.

---

## Get My Provider Profile

```graphql
query MyProviderProfile {
  myProviderProfile {
    id
    email
    firstName
    lastName
    phone
    profilePhoto
    role
    activeRole
    pushEnabled
    lastLoginAt
    providerProfile {
      id
      businessName
      businessDescription
      verificationStatus
      address
      city
      state
      country
      latitude
      longitude
      documents
      createdAt
      updatedAt
    }
    createdAt
    updatedAt
  }
}
```

**Authentication:** Required (`Authorization: Bearer <token>`)  
**Role:** `SERVICE_PROVIDER` only — returns `FORBIDDEN` for `SERVICE_USER` or `ADMIN`

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `ID!` | User ID |
| `pushEnabled` | `Boolean!` | Whether push notifications are on |
| `lastLoginAt` | `String` | ISO timestamp of last login |
| `providerProfile` | `ServiceProviderProfile` | Full provider record (always populated for `SERVICE_PROVIDER` role) |

> 💡 **Why use this instead of `me`?** Use `myProviderProfile` when you need the provider-specific nested data (`providerProfile`) and want a single query that guarantees the provider fields are present. `me` works too for providers but `myProviderProfile` makes intent explicit and will throw `FORBIDDEN` immediately if the user is not a provider.

---

# Push Notifications API

> 🔐 All push endpoints require authentication.

---

## Check Push Status

```graphql
query MyPushStatus {
  myPushStatus {
    pushEnabled
    hasDeviceRegistered
    playerId
  }
}
```

**Success Response**
```json
{
  "data": {
    "myPushStatus": {
      "pushEnabled": true,
      "hasDeviceRegistered": true,
      "playerId": "onesignal-player-abc123"
    }
  }
}
```

---

## Enable Push Notifications

Registers a device and enables push. Call this after the user grants permission in the mobile app.

```graphql
mutation EnablePush($playerId: String!) {
  enablePushNotifications(playerId: $playerId) {
    success
    message
    pushEnabled
  }
}
```

**Variables**
```json
{ "playerId": "onesignal-player-abc123" }
```

---

## Disable Push Notifications

Removes the device token and stops all push delivery.

```graphql
mutation DisablePush {
  disablePushNotifications {
    success
    message
    pushEnabled
  }
}
```

---

## Toggle Push On/Off (no device change)

Useful for a settings toggle when the device is already registered.

```graphql
mutation TogglePush($enabled: Boolean!) {
  togglePushNotifications(enabled: $enabled) {
    success
    message
    pushEnabled
  }
}
```

**Variables**
```json
{ "enabled": false }
```

---

## Existing Push Mutations (still available)

| Mutation | Description |
|----------|-------------|
| `registerPushToken(playerId)` | Lower-level: register device only |
| `unregisterPushToken` | Lower-level: unregister device only |
| `updatePushPreference(enabled)` | Lower-level: toggle without device change |

> The three new mutations (`enablePushNotifications`, `disablePushNotifications`, `togglePushNotifications`) are convenience wrappers around the above.

---

# Account Settings API

> 🔐 All settings endpoints require authentication.

Granular control over notification preferences, locale, and privacy — stored per user in the database.

---

## Get My Settings

```graphql
query GetMySettings {
  mySettings {
    id
    # In-app / push preferences
    notifyBookingUpdates
    notifyMessages
    notifyReviews
    notifyPromotions
    notifyDisputeUpdates
    notifyProviderVerification
    # Email preferences
    emailBookingUpdates
    emailMessages
    emailReviews
    emailPromotions
    emailNewsletters
    # Locale
    language
    timezone
    currency
    # Privacy
    showProfileToPublic
    showPhoneToProviders
    updatedAt
  }
}
```

**Success Response (defaults for a new user)**
```json
{
  "data": {
    "mySettings": {
      "notifyBookingUpdates": true,
      "notifyMessages": true,
      "notifyReviews": true,
      "notifyPromotions": false,
      "notifyDisputeUpdates": true,
      "notifyProviderVerification": true,
      "emailBookingUpdates": true,
      "emailMessages": false,
      "emailReviews": true,
      "emailPromotions": false,
      "emailNewsletters": false,
      "language": "en",
      "timezone": "Africa/Lagos",
      "currency": "NGN",
      "showProfileToPublic": true,
      "showPhoneToProviders": false
    }
  }
}
```

---

## Update My Settings

All fields are optional — only the fields you pass are changed.

```graphql
mutation UpdateSettings($input: UpdateSettingsInput!) {
  updateMySettings(input: $input) {
    success
    message
    settings {
      language
      timezone
      currency
      notifyPromotions
      emailNewsletters
      showPhoneToProviders
    }
  }
}
```

**Variables**
```json
{
  "input": {
    "language": "fr",
    "timezone": "Europe/Paris",
    "currency": "EUR",
    "notifyPromotions": true,
    "showPhoneToProviders": true
  }
}
```

### `UpdateSettingsInput` Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notifyBookingUpdates` | Boolean | `true` | Push when booking is accepted/completed |
| `notifyMessages` | Boolean | `true` | Push for new chat messages |
| `notifyReviews` | Boolean | `true` | Push for new reviews |
| `notifyPromotions` | Boolean | `false` | Push for promotional content |
| `notifyDisputeUpdates` | Boolean | `true` | Push for dispute status changes |
| `notifyProviderVerification` | Boolean | `true` | Push for verification approved/rejected |
| `emailBookingUpdates` | Boolean | `true` | Email on booking changes |
| `emailMessages` | Boolean | `false` | Email for messages |
| `emailReviews` | Boolean | `true` | Email on new reviews |
| `emailPromotions` | Boolean | `false` | Marketing emails |
| `emailNewsletters` | Boolean | `false` | Newsletter subscription |
| `language` | String | `"en"` | ISO 639-1 code (e.g. `"en"`, `"fr"`, `"es"`) |
| `timezone` | String | `"Africa/Lagos"` | IANA timezone (e.g. `"Europe/London"`) |
| `currency` | String | `"NGN"` | ISO 4217 code (e.g. `"USD"`, `"GBP"`) |
| `showProfileToPublic` | Boolean | `true` | Show profile on public browse |
| `showPhoneToProviders` | Boolean | `false` | Share phone number with providers |

### Error Responses

| Code | Trigger |
|------|---------|
| `VALIDATION_ERROR` | Invalid language code (must be ISO 639-1: `en`, `fr-FR`) |
| `VALIDATION_ERROR` | Invalid currency code (must be ISO 4217: `NGN`, `USD`) |

---

## Reset Settings to Defaults

```graphql
mutation ResetSettings {
  resetMySettings {
    success
    message
    settings {
      language
      timezone
      currency
    }
  }
}
```

---

## Deactivate Account

Soft-disables the account. Data is preserved but login is blocked. Device push token is also cleared.

```graphql
mutation DeactivateAccount($reason: String) {
  deactivateMyAccount(reason: $reason) {
    success
    message
  }
}
```

**Variables**
```json
{ "reason": "Taking a break" }
```

**Success Response**
```json
{
  "data": {
    "deactivateMyAccount": {
      "success": true,
      "message": "Your account has been deactivated. Contact support to reactivate."
    }
  }
}
```

> ⚠️ **Deactivate vs Delete**: `deactivateMyAccount` is reversible. `deleteMyAccount` permanently removes all data.

---

## Reactivate Account

Self-service account reactivation.

```graphql
mutation ReactivateAccount {
  reactivateMyAccount {
    success
    message
  }
}
```

**Error Responses**

| Code | Message |
|------|---------|
| `BAD_REQUEST` | Account is not deactivated |
| `NOT_FOUND` | User not found |

---

## Changelog

### v3.0.0 (April 2026)
- ✅ **Payment System Complete (Paystack)**
  - `initializePayment` - Start Paystack checkout
  - `verifyPayment` - Verify payment after callback
  - `payWithWallet` - Pay using wallet balance
  - `processRefund` - Admin refund processing
- ✅ **Wallet System**
  - `myWallet` - Get wallet balance and details
  - `myWalletTransactions` - Transaction history with filters
  - `adjustWalletBalance` - Admin balance adjustments
- ✅ **Bank Account Management**
  - `banks` - List Nigerian banks
  - `verifyBankAccount` - Verify account before adding
  - `addBankAccount` / `removeBankAccount`
  - `setDefaultBankAccount`
  - `myBankAccounts`
- ✅ **Withdrawal System**
  - `requestWithdrawal` - Provider withdrawal requests
  - `cancelWithdrawal` - Cancel pending withdrawal
  - `myWithdrawals` - Withdrawal history
  - `processWithdrawal` / `rejectWithdrawal` - Admin processing
- ✅ **Scheduled Payouts**
  - `setPayoutSchedule` - Configure automatic payouts
  - `disablePayoutSchedule`
  - `myPayoutSchedule`
  - `myPendingEarnings`
- ✅ **Payment Analytics**
  - `paymentStats` - Platform payment statistics
  - `myEarningsReport` - Provider earnings report
  - `adminPaymentAnalytics` - Admin analytics
- ✅ **Security Hardening (Phase 2)**
  - Enhanced rate limiting for auth endpoints (5 attempts/5min → 15min block)
  - Token invalidation on password change/reset
  - XSS prevention on all user inputs
  - NoSQL injection protection on search
  - IDOR protection on user queries

### v2.7.0 (April 5, 2026)
- ✅ Google Maps Platform integration (Geocoding, Distance Matrix, Places APIs)
- ✅ Frontend integration guide for Google Places Autocomplete (Web, React, React Native, Flutter)
- ✅ Address autocomplete component examples for provider onboarding
- ✅ User geolocation helper code for `nearbyProviders` query
- ✅ Complete provider onboarding example with address autocomplete + token handling
- ✅ API metadata updated with geolocation query documentation
- ✅ SpectaQL config updated with Maps & Push Notification features

### v2.6.0 (March 30, 2026)
- ✅ `becomeProvider` now returns `BecomeProviderResponse` (`user` + `accessToken` + `refreshToken`)
- ✅ Fresh `SERVICE_PROVIDER` JWT issued atomically with role upgrade — no stale token after onboarding
- ✅ Added `BecomeProviderResponse` GraphQL type
- ✅ Added full Provider Onboarding API section with critical token-replacement note
- ✅ Fixed `uploadProviderDocuments` UNAUTHORIZED during onboarding (root cause: stale JWT)

### v2.5.0 (March 29, 2026)
- ✅ `pushEnabled` field added to `User` type — returned on every `me` / `user` / `myProviderProfile` query
- ✅ `lastLoginAt` field added to `User` type — ISO timestamp of last successful login
- ✅ `myProviderProfile` query — providers can fetch their own full profile (with services list) separately from `me`
- ✅ `getUserById` now returns `activeRole`, `pushEnabled`, `lastLoginAt`
- ✅ `me` (getCurrentUser path) now returns `pushEnabled`, `lastLoginAt`

### v2.4.0 (March 29, 2026)
- ✅ Push status query (`myPushStatus`)
- ✅ `enablePushNotifications` — convenience mutation (register + enable)
- ✅ `disablePushNotifications` — convenience mutation (unregister + disable)
- ✅ `togglePushNotifications` — toggle without device change
- ✅ Account settings API (`mySettings`, `updateMySettings`, `resetMySettings`)
- ✅ Granular notification preferences (6 push types, 5 email types)
- ✅ Locale settings (`language`, `timezone`, `currency`)
- ✅ Privacy settings (`showProfileToPublic`, `showPhoneToProviders`)
- ✅ Account lifecycle: `deactivateMyAccount`, `reactivateMyAccount`
- ✅ `UserSettings` model added to Prisma schema

### v2.3.0 (March 29, 2026)
- ✅ Browse providers API (`providers` query) with filters + sorting
- ✅ Provider public profile (`providerProfile` query)
- ✅ Nearby providers API (`nearbyProviders` query) with Haversine geolocation
- ✅ `ProviderSortBy` enum: `RATING_DESC`, `POPULARITY_DESC`, `NEWEST`, `NAME_ASC`
- ✅ `ProviderFiltersInput`: `city`, `state`, `country`, `categoryId`, `verifiedOnly`, `minRating`
- ✅ `distanceKm` field on nearby provider results
- ✅ Configurable search radius (default 25 km, max 100 km)

### v2.2.0 (March 28, 2026)
- ✅ Provider gallery images (`uploadProviderImages`, `removeProviderImage`)
- ✅ Provider documents (`uploadProviderDocuments`, `removeProviderDocument`)
- ✅ Provider likes (`likeProvider`, `unlikeProvider`, `toggleProviderLike`)
- ✅ Provider like queries (`isProviderLiked`, `providerLikeCount`, `myLikedProviders`)
- ✅ `ServiceProviderProfile` now includes `images`, `averageRating`, `totalReviews`, `likeCount`, `isLiked`

### v2.1.0 (March 22, 2026)
- ✅ OneSignal push notifications (iOS + Android)
- ✅ Device registration API (`registerPushToken`, `unregisterPushToken`)
- ✅ Push preference toggle (`updatePushPreference`)
- ✅ iOS-specific features (badge, silent push, content-available)
- ✅ Android-specific features (channels, sounds, visibility)
- ✅ Automatic push for bookings, messages, reviews, verification

### v2.0.0 (March 2026)
- ✅ Added comprehensive rate limiting (per-user/IP)
- ✅ Enhanced security (token invalidation, query depth limiting)
- ✅ Real-time messaging with Socket.io
- ✅ Background job processing with BullMQ
- ✅ Redis integration for caching and pub/sub
- ✅ Dispute resolution system
- ✅ Favourites system
- ✅ Provider verification workflow
- ✅ Admin management APIs

### v1.0.0 (Initial Release)
- Authentication system
- User management
- Basic provider system
- Service CRUD
- Booking system
- Review system

---

**API Version**: 3.0.0  
**Last Updated**: April 2026  
**Documentation**: https://backend-ehtm.onrender.com/docs
