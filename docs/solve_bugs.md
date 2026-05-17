# EasyKonnect — Bug Fix Playbook

This document is the action plan for the open issues raised during review. It is split by **owner** so you can hand each section to the right person.

- **Backend** changes are already merged (see "Backend changes already shipped" below).
- **Mobile / OneSignal / Firebase** items are the responsibility of the mobile developer and the project's Firebase/OneSignal admin. The backend is verified clean for all of them.

---

## 1. Backend changes already shipped

These were applied during the review session. No further action needed unless you re-run them in another environment.

### 1.1. `startService` payment guard
**File:** `src/services/booking.service.ts` (lines ~657–679)

The previous logic was internally contradictory and impossible to call. It now enforces:
- Booking status must be `ACCEPTED`
- `payment.status` must be `COMPLETED`

If either fails, the mutation throws `INVALID_BOOKING_STATUS` or `PAYMENT_REQUIRED`.

### 1.2. `becomeProvider` description validation
**File:** `src/services/provider.service.ts`

The `validateText(text, fieldName, minLength, maxLength)` calls were passing the max as the **min** argument. The fix:
- `businessDescription` now accepts **10–250 characters** (was rejecting anything under 10,000)
- `address` now accepts **0–255 characters** (was rejecting anything under 255)

Applied to both `becomeProvider` and `updateProviderProfile` for consistency.

### 1.3. Geo filtering on services (`#1` + `#2`)
**Files:** `src/graphql/schemas/index.ts`, `src/services/service.service.ts`, `src/graphql/resolvers/index.ts`

- `ServiceFiltersInput` now supports: `city`, `state`, `latitude`, `longitude`, `radiusKm`
- New query: `nearbyServices(input: NearbyServicesInput!): PaginatedNearbyServices!`
  - Returns each service annotated with `distanceKm`
  - Sorted by distance ascending
  - Verified providers only

### 1.4. Real-time booking events (`#5`)
**File:** `src/services/booking.service.ts`

Added `dispatchBookingEvent()` helper that, after every status change, fans out:
1. **Socket emit** via `emitToUser(recipientId, "booking:<kind>", { bookingId, booking })`
2. **In-app notification row** via the existing `notifyBooking*` helpers
3. **Push notification** via `sendBookingPush` (skipped for `started` since the helper has no variant for it)

Wired into:
| Mutation | Recipient | Event |
|---|---|---|
| `acceptBooking` | Customer | `booking:accepted` |
| `rejectBooking` | Customer | `booking:rejected` |
| `startService` | Customer | `booking:started` |
| `completeService` | Customer | `booking:completed` |
| `cancelBooking` | Provider | `booking:cancelled` |

All side-effect calls are wrapped in `try/catch` and logged on failure — a flaky push or socket cannot roll back a successful DB transition.

### 1.5. Full push-notification coverage + admin broadcast endpoints
**Files:** `src/services/payment.service.ts`, `src/services/messaging.service.ts`, `src/services/user-management.service.ts`, `src/services/withdrawal.service.ts`, `src/services/notification.service.ts`, `src/graphql/schemas/index.ts`, `src/graphql/resolvers/index.ts`

Previously 13 of the 18 notification trigger sites wrote an in-app row but never fired a push. Customers got no phone buzz for payment events, new chat messages, account moderation, or withdrawals. Now every trigger fans out push as well.

**Strategy:** rather than modifying 13 call sites individually, each service got a small `notifyAndPush` (or upgraded `sendNotification`) wrapper that fires both channels. New call sites pick this up automatically.

| Trigger | In-app | Push (new) | Socket |
|---|:---:|:---:|:---:|
| Payment verified (customer + provider) | ✓ | ✓ | – |
| Payment fails during verification | ✓ | ✓ | – |
| Payment released to provider | ✓ | ✓ | – |
| Refund processed | ✓ | ✓ | – |
| New message in conversation | ✓ | ✓ | ✓ |
| Admin bans / unbans user | ✓ | ✓ | – |
| Admin restricts / removes restriction | ✓ | ✓ | – |
| Withdrawal submitted / approved / completed / failed | ✓ | ✓ | – |

Booking events were already wired; nothing changed there.

**New admin broadcast endpoints:**

```graphql
mutation AdminBroadcast($input: BroadcastNotificationInput!) {
  adminBroadcastNotification(input: $input) {
    recipientCount
    inAppCreated
    pushDelivery
    pushError
  }
}

mutation SuperAdminBroadcast($input: BroadcastNotificationInput!) {
  superAdminBroadcastNotification(input: $input) { ... }
}
```

Four targeting modes via `BroadcastTargetInput.mode`:
- `USER_IDS` — specific list
- `ROLE` — `["SERVICE_USER"]`, `["SERVICE_PROVIDER"]`, `["ADMIN"]` (super-admin only), or any combination
- `ALL` — every active user the caller is allowed to reach
- `LOCATION` — by `city` / `state` (matches against provider profiles)

**Permission boundary:**
- `adminBroadcastNotification` — ADMIN or SUPER_ADMIN. Can target `SERVICE_USER` + `SERVICE_PROVIDER` only.
- `superAdminBroadcastNotification` — SUPER_ADMIN only. Can additionally target the `ADMIN` role.
- An ADMIN attempting to target `ADMIN` or `SUPER_ADMIN` gets a `FORBIDDEN` error before the broadcast runs.

**Safety:**
- Banned / deactivated users are excluded automatically (ACTIVE-status filter on every recipient query)
- Per-admin daily cap: 50 broadcasts / 24h via Redis sorted-set sliding window — protects against a compromised admin account spamming phishing pushes. Returns `RATE_LIMITED` when exceeded.
- For `ALL`-mode broadcasts that span every allowedRole (super-admin), the push step uses OneSignal's segment endpoint (`sendPushToAll`) instead of passing tens of thousands of player IDs in one HTTP body.

---

### 1.6. Self-booking prevention + own-service filtering
**Files:** `src/services/booking.service.ts`, `src/services/service.service.ts`, `src/services/browse.service.ts`, `src/graphql/resolvers/index.ts`

Providers also hold a base user role, so without a guard they could see and book their own services from the customer side. Two layers of defense added.

**1. Hard backend block at the mutation:** `createBooking` now throws `SELF_BOOKING_NOT_ALLOWED` if `service.provider.userId === bookerUserId`. This is the source of truth — even a direct mutation call with a known service ID can't bypass it.

**2. Own-services filtered out of customer-facing list queries:** when the caller is authenticated, the following queries exclude services / providers owned by the caller:
| Query | Mechanism |
|---|---|
| `services(filters)` | Adds `provider.is.userId: { not: caller.userId }` to the where clause |
| `nearbyServices(input)` | Adds `userId: { not: caller.userId }` to the candidate-provider geo query (pre-haversine) |
| `nearbyProviders(input)` | Adds `userId: { not: caller.userId }` to the provider query |
| `providers(input)` | Same |

`providerProfile(providerId)` is **intentionally not filtered** — a provider should still be able to view their own storefront page directly.

Anonymous and customer-only accounts see everything normally. The exclusion only kicks in when the caller's `userId` happens to also own a `ServiceProvider` record.

---

### 1.7. Paystack callback bridge for native deep links
**Files:** `src/app/api/payments/paystack/callback/route.ts` (new), `src/services/payment.service.ts`, `src/graphql/schemas/index.ts`, `src/graphql/resolvers/index.ts`, `src/config/index.ts`

**Why this exists:** Paystack's hosted checkout cannot redirect a browser directly to a non-http(s) URL like `easykonnect://payment-callback`. Modern browsers block sandboxed iframes from navigating to custom schemes, so the user got stuck on Paystack's "Payment Successful" screen with no way back into the app.

**The fix:** an HTTPS bridge route that sits between Paystack and the deep link.

**New schema field:**
```graphql
input InitializePaymentInput {
  bookingId: ID!
  callbackUrl: String        # legacy/web flow (unchanged)
  returnDeepLink: String     # NEW — native app deep link
}
```

**New flow when `returnDeepLink` is set:**
1. Backend tells Paystack to redirect to `${BACKEND_URL}/api/payments/paystack/callback`
2. The deep link is embedded in Paystack's transaction `metadata.returnDeepLink`
3. After payment, Paystack redirects to the bridge (HTTPS — works)
4. Bridge calls `paystack.verifyTransaction(reference)` to recover the deep link from metadata
5. Bridge calls `verifyPayment(reference)` so Payment is COMPLETED + Booking is IN_PROGRESS *before* the app reopens (idempotent — webhook firing later is harmless)
6. Bridge returns a tiny HTML page that triggers `window.location.replace("easykonnect://payment-callback?reference=<ref>&status=success")` plus a manual "Open the app" fallback button
7. Mobile OS picks up the deep link and reopens the app

**HTML/JS injection hardened:** all values from Paystack metadata are escaped before embedding in the bouncing page. `<` is converted to `<` so a malicious deep link cannot break out of the embedded JS string literal and become a real `<script>` tag.

**Mobile integration change:** the mobile app should send `returnDeepLink: "easykonnect://payment-callback"` instead of `callbackUrl: "easykonnect://payment-callback"`. The legacy `callbackUrl` still works for web flows.

**Required env addition:**
```
BACKEND_URL=https://api.easykonnect.com
```
(If unset, falls back to `FRONTEND_URL` — fine for dev, wrong for prod where the API is on a separate origin.)

---

## 2. Issues that turned out to be **false positives** (no work needed)

The following claims were investigated and are **already correctly implemented**. Do not spend time on them — point reviewers at the line refs below.

| Claim | Verdict | Evidence |
|---|---|---|
| "Webhook should auto-finalize payment if mobile callback fails" | Already done | Webhook calls the same `verifyPayment()` as the mobile callback; idempotent via Redis event tracking. `src/app/api/webhooks/paystack/route.ts` + `src/services/payment.service.ts:1127–1194` |
| "User should only pay after provider accepts booking" | Already enforced | `src/services/payment.service.ts:233` — throws if `booking.status !== ACCEPTED` |
| "User should only review after booking is completed" | Already enforced | `src/services/review.service.ts:111` — throws if `booking.status !== COMPLETED` |
| "Provider profile should return full storefront data" | Already returns it | `PublicProviderProfile` type in `src/graphql/schemas/index.ts:531–552` already exposes `images`, `activeServices`, `averageRating`, `totalReviews`, `categories`, `address/city/state/country/latitude/longitude`. If the frontend isn't seeing them, it's a missing field in the frontend's GraphQL selection set. |
| "Provider reviews should work independently of service reviews" | Already does | `Review.providerId` exists in the Prisma model (`prisma/schema.prisma:387`), and the `providerReviews(providerId, filters, pagination)` query (`src/graphql/schemas/index.ts:2015`) already returns all reviews for a provider across all their services in one call. |

---

## 3. Push notifications — Mobile / Firebase / OneSignal action plan

> **Status of the backend:** Verified clean. The backend stores `User.oneSignalPlayerId` after login, sends to OneSignal via `include_player_ids`, and writes **zero tags**. None of the push issues described in the bug report are caused by backend code.

### 3.1. What the error actually is

The chain in the device logs:

```
Firebase Installations service → FIS_AUTH_ERROR
   ↓
No FCM token issued for the device
   ↓
OneSignal SDK can't get an FCM token
   ↓
OneSignal subscription created with enabled: false, empty address
   ↓
Backend can call sendPushToUser successfully (HTTP 200)
   but OneSignal silently drops delivery because there is no FCM address
```

The fix is **on the mobile/Firebase/OneSignal side**, not the backend.

### 3.2. Already verified correct (do not redo)

| # | Item | Status |
|---|---|---|
| 1 | Android package name `com.easykonnet.app` matches Firebase app + `google-services.json` | ✅ |
| 2 | `google-services.json` belongs to project `easykonect-6b68a` | ✅ |
| 3 | Firebase Cloud Messaging API V1 enabled (Legacy disabled — correct) | ✅ |
| 4 | OneSignal Android (FCM) is Active, Service Account JSON `easykonect-6b68a.json` uploaded, Project ID `easykonect-6b68a` | ✅ |
| 5 | Backend stores OneSignal player ID after login (`src/services/push.service.ts:109–161`) | ✅ |
| 6 | Backend sends pushes via stored player ID (`src/services/push.service.ts:346–388`) | ✅ |
| 7 | Backend sets zero OneSignal tags (full-tree grep confirmed) | ✅ |

### 3.3. Mobile developer — checklist to run

Run these in order. Stop and report at the first one that doesn't apply / doesn't help.

#### Step 1. Refresh the bundled `google-services.json`

```bash
# From the mobile repo root:
cp ~/Downloads/google-services.json android/app/google-services.json
cd android
./gradlew clean
cd ..
```

The freshly downloaded file should match exactly:
- `project_id`: `easykonect-6b68a`
- `package_name`: `com.easykonnet.app`
- `mobilesdk_app_id`: `1:97418604821:android:841108aefd136d7c30791c`

#### Step 2. Fully uninstall the app from the test device

Not just reinstall — **uninstall completely**. This wipes the cached Firebase Installation ID and forces a fresh handshake on next launch.

```bash
adb uninstall com.easykonnet.app
```

#### Step 3. Confirm OneSignal Android SDK is on a recent version

The legacy FCM HTTP API is **disabled** in your Firebase project (correct, since it's deprecated). Older OneSignal SDKs only know how to talk to the legacy API and will fail.

Check `package.json` (React Native / Expo) or `android/app/build.gradle` (native):

- React Native: `react-native-onesignal` should be **≥ 5.0.0**
- Native Android: `com.onesignal:OneSignal` should be **≥ 5.0.0**
- Flutter: `onesignal_flutter` should be **≥ 5.0.0**

If older, upgrade and rebuild.

#### Step 4. Confirm Google Play Services on the test device

Settings → Apps → Google Play Services → version. Should be a 2024+ build. Update via Play Store if old.

A signed-out / outdated Play Services account is a frequent cause of FIS_AUTH_ERROR.

#### Step 5. Confirm device clock is correct

Settings → System → Date & time → "Set time automatically" must be **on**. FIS rejects requests if the clock is off by more than a few minutes.

#### Step 6. Try a different network

If the test device is on a corporate or filtered Wi-Fi, switch to mobile data and retest. Some networks block `firebaseinstallations.googleapis.com`.

#### Step 7. Confirm Firebase App Check is not enforcing FCM

Firebase Console → Build → App Check → Apps tab. If "Cloud Messaging" shows **Enforced** but the mobile app does not register an App Check provider, all FCM token requests are rejected.

If you don't intentionally use App Check, ensure FCM is in **Unenforced** mode.

#### Step 8. Rebuild + reinstall + login

```bash
# From mobile repo:
yarn android  # or your equivalent build command
```

After login, capture device logs:

```bash
adb logcat | grep -iE "onesignal|firebase|fcm|fis"
```

Expected on success:
- `FirebaseInstallations` → returns an installation token (no `FIS_AUTH_ERROR`)
- `FCM` → "Token retrieved: ..."
- `OneSignal` → "Subscription enabled, push token registered"

### 3.4. If FIS_AUTH_ERROR still appears after all 8 steps

Capture the **full stack trace**, not just the top-line error. There is almost always a sub-error code:

- `INVALID_ARGUMENT` → `google-services.json` mismatch with the running APK signature
- `PERMISSION_DENIED` → Service Account JSON in OneSignal is from a different project, or the service account was deleted in Firebase
- `UNAUTHENTICATED` → device clock skew or network blocking
- `RESOURCE_EXHAUSTED` → Firebase project quota hit (unlikely on a new project)

Send the full trace to the backend team for triage.

### 3.5. SHA-1 fingerprint (optional but recommended)

The Firebase app card shows **"SHA certificate fingerprints"** is empty. For pure FCM messaging this is **not required**, so it is not the cause of the current bug. However, you will need it later if you add Google Sign-In, Dynamic Links, or App Check.

To add now:

```bash
# Debug fingerprint
cd android
./gradlew signingReport
# Copy SHA-1 and SHA-256 from the "debug" variant
```

Paste both into Firebase Console → Project Settings → Your apps → Android app → Add fingerprint.

Repeat for the release keystore when you ship.

### 3.6. OneSignal tag-limit overflow

The bug report mentioned: *"OneSignal tag update also fails because the current OneSignal plan tag limit has been exceeded."*

The backend writes **zero tags** (verified by full-tree grep — no calls to `tags`, `setTag`, `sendTag`, `addTag`, or any OneSignal tag API). This is purely mobile-side.

OneSignal free tier limits to ~10 tag keys per user. To audit:

```bash
# In the mobile repo
grep -rn "sendTag\|addTag\|addTags\|sendTags\|User.addTag" src/
```

For each result, ask: "Does this tag actually drive a notification segment?" If no, delete it. Common over-tagging mistakes:

- Tagging every user preference (use a single JSON blob in user metadata instead)
- Tagging every event the user performs (these belong in your analytics tool, not OneSignal)
- Tagging UI state (theme, language) when you don't segment notifications by it

Recommended tag set for EasyKonnect:
- `role` → `user` / `provider`
- `city` → user's city (only if you send city-targeted campaigns)
- `verified` → `true` / `false` for providers (only if you message verified providers separately)

That's it. Three tags max.

To clear existing over-tagged users, call OneSignal's bulk delete tags API or wait for the natural 30-day inactivity cleanup.

---

## 4. Quick verification checklist (after the mobile dev runs section 3.3)

Once the mobile changes ship, verify on the backend side:

```bash
# 1. After a user logs in on a fresh install, check the user record
# Replace <USER_ID> with the test user's id
mongosh <DATABASE_URL> --eval '
  db.users.findOne(
    { _id: ObjectId("<USER_ID>") },
    { oneSignalPlayerId: 1, pushEnabled: 1 }
  )
'
# Expect: oneSignalPlayerId is a non-empty UUID string, pushEnabled: true
```

```bash
# 2. Send a test push from the OneSignal dashboard to that player ID directly
#    OneSignal Dashboard → Messages → New Push → "Send to specific Subscriptions"
#    Paste the oneSignalPlayerId from the DB
# Expect: device receives the notification within a few seconds
```

```bash
# 3. Trigger a real backend push by accepting a booking from the provider account
#    Watch the device. Watch the backend logs for any "Failed to send booking push" errors.
```

If step 1 has an `oneSignalPlayerId` and step 2 delivers but step 3 doesn't, the issue is in our `sendBookingPush` payload — bring the failing log line back to the backend team.

If step 1 has `oneSignalPlayerId: null`, the mobile app is not calling the `registerPushToken(playerId)` mutation after login. That's a mobile bug.

If step 2 doesn't deliver, the FCM/OneSignal handshake is still broken — return to section 3.3.

---

## 5. Reference — files touched in this work

### Source files

| File | Change |
|---|---|
| `src/services/booking.service.ts` | Fixed `startService` guards; added `dispatchBookingEvent()` helper; wired events into 5 booking mutations |
| `src/services/provider.service.ts` | Fixed arg-order on `validateText` for `businessDescription` (10–250) and `address` in `becomeProvider` and `updateProviderProfile` |
| `src/services/service.service.ts` | Added geo filters to `getServices()`; added `getNearbyServices()` |
| `src/services/payment.service.ts` | `initializePayment` now accepts `returnDeepLink` and resolves `callback_url` to the backend bridge for native flows; embeds deep link in Paystack metadata |
| `src/graphql/schemas/index.ts` | Extended `ServiceFiltersInput` with geo fields; added `NearbyServicesInput`, `ServiceWithDistance`, `PaginatedNearbyServices`, `nearbyServices` query; added `returnDeepLink` to `InitializePaymentInput` |
| `src/graphql/resolvers/index.ts` | Wired `nearbyServices` resolver; extended `services` and `initializePayment` resolver typing |
| `src/config/index.ts` | Added `config.platform.backendUrl` (reads `BACKEND_URL`, falls back to `FRONTEND_URL`) |
| `src/app/api/payments/paystack/callback/route.ts` | **New file.** HTTPS bridge that bounces Paystack redirects into the mobile app's deep link |
| `src/services/notification.service.ts` | Added `broadcastNotification()` with `BroadcastTarget` (USER_IDS / ROLE / ALL / LOCATION) and allowedRoles permission gate |
| `src/services/messaging.service.ts` | Wired `sendMessagePush` into both message-create paths |
| `src/services/user-management.service.ts` | Added local `notifyAndPush` helper, replaced 4 moderation `createNotification` call sites |
| `src/services/withdrawal.service.ts` | Added local `notifyAndPush` helper, replaced 3 withdrawal `createNotification` call sites |

### Test files added

| File | Tests |
|---|---|
| `src/__tests__/services/booking.service.test.ts` | 15 — startService payment guard (5), event dispatch fan-out across all 5 mutations, side-effect failure isolation, **self-booking guard (4)** |
| `src/__tests__/services/provider.service.test.ts` | 8 — businessDescription 10–250 validation in becomeProvider + updateProviderProfile, address arg-order regression |
| `src/__tests__/services/service.service.test.ts` | 14 — geo filtering on `getServices`, `getNearbyServices` distance sort + radius cutoff + search + metadata, **own-service exclude filter (6)** |
| `src/__tests__/services/browse.service.test.ts` | +3 added — **excludeUserId on `browseProviders` + `getNearbyProviders`** |
| `src/__tests__/services/payment.service.test.ts` | 9 — pay-after-accept guard, callback URL resolution (bridge / legacy / fallback / both-set precedence), metadata embedding |
| `src/__tests__/services/review.service.test.ts` | 5 — review-after-complete guard, ownership, double-review prevention |
| `src/__tests__/services/paystack-callback-bridge.test.ts` | 8 — bridge route HTML output, reference handling, fallbacks on Paystack/verifyPayment failure, HTML/JS injection escaping |
| `src/__tests__/services/broadcast.service.test.ts` | 12 — **all four targeting modes (USER_IDS / ROLE / ALL / LOCATION), allowedRoles permission gate, ACTIVE-status filter, fan-out resilience when push fails** |

**74 new tests** added overall (49 original sweep + 13 self-booking/own-service + 12 broadcast). Full suite: **19 suites, 319 tests, 0 failures**. `npx tsc --noEmit` clean.

Run the tests with:
```bash
npx jest                          # all unit tests
npx jest src/__tests__/services/  # only the bug-fix coverage
```
