# EasyKonnect API - Request & Response Examples

This document provides detailed examples for all API operations.

---

## Authentication Flow

### 1. Register a New User

**Request:**
```graphql
mutation Register {
  register(input: {
    email: "john.doe@example.com"
    password: "SecurePass123"
    firstName: "John"
    lastName: "Doe"
    phone: "+2348012345678"
  }) {
    success
    message
    requiresVerification
  }
}
```

**Success Response (200):**
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

**Error Response - User Already Exists:**
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

---

### 2. Verify Email with OTP

**Request:**
```graphql
mutation VerifyEmail {
  verifyEmail(input: {
    email: "john.doe@example.com"
    otp: "123456"
  }) {
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

**Success Response (200):**
```json
{
  "data": {
    "verifyEmail": {
      "success": true,
      "message": "Email verified successfully!",
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "john.doe@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_USER",
        "status": "ACTIVE",
        "isEmailVerified": true
      },
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI1MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTEiLCJlbWFpbCI6ImpvaG4uZG9lQGV4YW1wbGUuY29tIiwicm9sZSI6IlNFUlZJQ0VfVVNFUiIsImlhdCI6MTY0NTM4NjQwMCwiZXhwIjoxNjQ1OTkxMjAwfQ.abc123",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI1MDdmMWY3N2JjZjg2Y2Q3OTk0MzkwMTEiLCJlbWFpbCI6ImpvaG4uZG9lQGV4YW1wbGUuY29tIiwicm9sZSI6IlNFUlZJQ0VfVVNFUiIsImlhdCI6MTY0NTM4NjQwMCwiZXhwIjoxNjQ4MDY0ODAwfQ.xyz789"
    }
  }
}
```

**Error Response - Invalid OTP:**
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

**Error Response - OTP Expired:**
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

---

### 3. Resend Verification OTP

**Request:**
```graphql
mutation ResendOtp {
  resendVerificationOtp(input: {
    email: "john.doe@example.com"
  }) {
    success
    message
  }
}
```

**Success Response (200):**
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

---

### 4. Login

**Request:**
```graphql
mutation Login {
  login(input: {
    email: "john.doe@example.com"
    password: "SecurePass123"
  }) {
    user {
      id
      email
      firstName
      lastName
      role
      status
    }
    accessToken
    refreshToken
  }
}
```

**Success Response (200):**
```json
{
  "data": {
    "login": {
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "john.doe@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_USER",
        "status": "ACTIVE"
      },
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
}
```

**Error Response - Invalid Credentials:**
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

**Error Response - Email Not Verified:**
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

**Error Response - Account Locked:**
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

---

### 5. Refresh Token

**Request:**
```graphql
mutation RefreshToken {
  refreshToken(refreshToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...") {
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

**Success Response (200):**
```json
{
  "data": {
    "refreshToken": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "user": {
        "id": "507f1f77bcf86cd799439011",
        "email": "john.doe@example.com",
        "firstName": "John",
        "lastName": "Doe",
        "role": "SERVICE_USER",
        "status": "ACTIVE"
      }
    }
  }
}
```

**Error Response - Invalid Token:**
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

## Password Reset Flow

### 1. Request Password Reset

**Request:**
```graphql
mutation ForgotPassword {
  forgotPassword(input: {
    email: "john.doe@example.com"
  }) {
    success
    message
  }
}
```

**Response (always returns success for security):**
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

### 2. Reset Password with OTP

**Request:**
```graphql
mutation ResetPassword {
  resetPassword(input: {
    email: "john.doe@example.com"
    otp: "654321"
    newPassword: "NewSecurePass456"
  }) {
    success
    message
  }
}
```

**Success Response (200):**
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

**Error Response - Invalid Reset Code:**
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

---

## User Operations

### Get Current User (Authenticated)

**Request Headers:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Request:**
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

**Success Response (200):**
```json
{
  "data": {
    "me": {
      "id": "507f1f77bcf86cd799439011",
      "email": "john.doe@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "phone": "+2348012345678",
      "role": "SERVICE_USER",
      "status": "ACTIVE",
      "isEmailVerified": true,
      "createdAt": "2024-02-20T10:30:00.000Z",
      "updatedAt": "2024-02-20T10:30:00.000Z"
    }
  }
}
```

**Error Response - Not Authenticated:**
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

### Update Profile

**Request Headers:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Request:**
```graphql
mutation UpdateProfile {
  updateProfile(input: {
    firstName: "Jonathan"
    lastName: "Smith"
    phone: "+2348098765432"
  }) {
    id
    email
    firstName
    lastName
    phone
    updatedAt
  }
}
```

**Success Response (200):**
```json
{
  "data": {
    "updateProfile": {
      "id": "507f1f77bcf86cd799439011",
      "email": "john.doe@example.com",
      "firstName": "Jonathan",
      "lastName": "Smith",
      "phone": "+2348098765432",
      "updatedAt": "2024-02-20T11:45:00.000Z"
    }
  }
}
```

---

## Admin Operations

### Get All Users (Admin Only)

**Request Headers:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... (Admin token)
```

**Request:**
```graphql
query GetUsers {
  users(pagination: { page: 1, limit: 10 }) {
    items {
      id
      email
      firstName
      lastName
      role
      status
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

**Success Response (200):**
```json
{
  "data": {
    "users": {
      "items": [
        {
          "id": "507f1f77bcf86cd799439011",
          "email": "john.doe@example.com",
          "firstName": "John",
          "lastName": "Doe",
          "role": "SERVICE_USER",
          "status": "ACTIVE",
          "createdAt": "2024-02-20T10:30:00.000Z"
        },
        {
          "id": "507f1f77bcf86cd799439012",
          "email": "jane.smith@example.com",
          "firstName": "Jane",
          "lastName": "Smith",
          "role": "SERVICE_PROVIDER",
          "status": "ACTIVE",
          "createdAt": "2024-02-19T15:20:00.000Z"
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

**Error Response - Unauthorized:**
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

### Delete User (Admin Only)

**Request Headers:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... (Admin token)
```

**Request:**
```graphql
mutation DeleteUser {
  deleteUser(id: "507f1f77bcf86cd799439011") {
    success
    message
  }
}
```

**Success Response (200):**
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

**Error Response - User Not Found:**
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

---

## Error Codes Reference

| Code | HTTP Equivalent | Description |
|------|-----------------|-------------|
| `UNAUTHENTICATED` | 401 | Missing or invalid authentication token |
| `UNAUTHORIZED` | 403 | Insufficient permissions |
| `USER_NOT_FOUND` | 404 | User does not exist |
| `USER_ALREADY_EXISTS` | 409 | Email already registered |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `EMAIL_NOT_VERIFIED` | 403 | Email verification required |
| `ACCOUNT_LOCKED` | 423 | Too many failed login attempts |
| `ACCOUNT_SUSPENDED` | 403 | Account suspended by admin |
| `ACCOUNT_DEACTIVATED` | 403 | Account has been deactivated |
| `OTP_EXPIRED` | 400 | Verification code expired |
| `OTP_NOT_FOUND` | 400 | No verification code found |
| `INVALID_OTP` | 400 | Incorrect verification code |
| `RESET_NOT_FOUND` | 400 | No password reset requested |
| `RESET_EXPIRED` | 400 | Password reset code expired |
| `INVALID_RESET_CODE` | 400 | Incorrect reset code |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token invalid or expired |
| `ALREADY_VERIFIED` | 400 | Email already verified |
