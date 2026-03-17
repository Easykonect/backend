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

## API Features (v2.0.0)

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

### 🔜 Coming Soon

| Feature | Status |
|---------|--------|
| Payment Integration (Paystack) | 🔜 In Progress |
| Push Notifications (FCM) | 🔜 Planned |
| Geolocation Search | 🔜 Planned |

---

## Security & Rate Limits

### Rate Limits

| Operation | Limit | Window |
|-----------|-------|--------|
| General API | 100 requests | 15 minutes |
| Login | 10 attempts | 15 minutes |
| Authentication | 5 attempts | 1 minute |
| OTP Verification | 5 attempts | 5 minutes |
| Password Reset | 3 attempts | 1 hour |
| File Uploads | 20 uploads | 1 minute |
| Messaging | 60 messages | 1 minute |

### Security Features

- 🔒 **Password Hashing**: bcrypt with 12 salt rounds
- 🔒 **OTP Security**: SHA-256 hashing with timing-safe comparison
- 🔒 **JWT Tokens**: Access (7d) + Refresh (30d) with blacklisting
- 🔒 **Account Lockout**: 5 failed attempts = 30-minute lockout
- 🔒 **Query Depth Limit**: Maximum 10 levels (prevents DoS)
- 🔒 **Request Size Limit**: 1MB maximum body size
- 🔒 **Introspection**: Disabled in production

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

**What it returns:** Returns a `User` object containing all profile fields: id, email, firstName, lastName, phone, role (SERVICE_USER or SERVICE_PROVIDER), status (ACTIVE, SUSPENDED, etc.), isEmailVerified boolean, and timestamps (createdAt, updatedAt).

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
    status
    isEmailVerified
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
      "status": "ACTIVE",
      "isEmailVerified": true,
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

## React Native / Mobile Push Notifications

Notifications are stored in the database. For push notifications, integrate with:
- **Firebase Cloud Messaging (FCM)** for Android
- **Apple Push Notification Service (APNS)** for iOS

The `isPushed` and `pushedAt` fields track push notification delivery status.

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

## Mobile Push Notifications

While WebSocket handles in-app real-time updates, for offline users you'll want push notifications:

1. **Store device tokens** in your database (via a separate API)
2. **Background workers** check for offline users when sending notifications
3. **Send push via** Firebase Cloud Messaging (FCM) or Apple Push Notification Service (APNS)

The notification system automatically:
- Sends WebSocket notification if user is online
- Creates database notification if user is offline
- Future: Triggers push notification for offline users

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

## Changelog

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

**API Version**: 2.0.0  
**Last Updated**: March 14, 2026  
**Documentation**: https://backend-ehtm.onrender.com/docs
