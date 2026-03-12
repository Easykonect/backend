# EasyKonnect GraphQL API - Frontend Integration Guide

## Overview

This API uses **GraphQL** over HTTP POST requests. All requests go to a single endpoint:

- **Development**: `http://localhost:3000/api/graphql`
- **Production**: `https://backend-ehtm.onrender.com/api/graphql`

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

**What this API does:** This API is used for updating the authenticated user's profile information (firstName, lastName, phone). It performs a partial update - only the fields you include will be changed. Email cannot be changed through this endpoint. The `updatedAt` timestamp is automatically updated.

**What it returns:** Returns the updated `User` object containing the modified fields (id, email, firstName, lastName, phone, updatedAt) reflecting the new values.

### Request

```graphql
mutation UpdateProfile($input: UpdateProfileInput!) {
  updateProfile(input: $input) {
    id
    email
    firstName
    lastName
    phone
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
    "phone": "+2348098765432"
  }
}
```

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
      "updatedAt": "2026-03-08T11:45:00.000Z"
    }
  }
}
```

---

# Admin APIs (Admin Role Required)

These APIs require an admin access token (ADMIN or SUPER_ADMIN role). They provide platform management capabilities for administrators.

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
