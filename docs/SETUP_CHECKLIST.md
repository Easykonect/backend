# Easykonnet — Setup Checklist

Everything needed to go live. Work top to bottom.

---

## On the Server

| What | Why |
|------|-----|
| **Node.js 20** | Runs the backend app |
| **PM2** | Keeps the app alive and restarts it on crashes/reboots |
| **Redis** | Required for OTP codes, rate limiting, and background jobs (emails, payment release) |
| **Nginx/apache** | Routes traffic from the internet to the app |
| **Certbot (Let's Encrypt)** | Free SSL — Paystack and mobile apps reject non-HTTPS endpoints |
| **UFW Firewall** | Blocks all ports except SSH, HTTP, and HTTPS |

---

## Third-Party Accounts

| Service | Sign Up | Why |
|---------|---------|-----|
| **MongoDB Atlas** | cloud.mongodb.com | The database — stores all users, bookings, and payments |
| **Paystack** ⚠️ | paystack.com | Processes all customer payments and provider bank payouts |
| **Cloudinary** | cloudinary.com | Stores and serves provider and service images |
| **Mailtrap** | mailtrap.io | Sends OTP codes, booking confirmations, and password resets |
| **OneSignal** | onesignal.com | Sends push notifications to users and providers |
| **Google Cloud** | console.cloud.google.com | Powers nearby provider search and address lookup |
| **Sentry** | sentry.io | Captures production errors with full details |

---

## Keys to Collect

After signing up, collect these and paste them into the `.env` file:

```
DATABASE_URL           → MongoDB Atlas  → Connect → Connection String
REDIS_URL              → Local server   → redis://:password@127.0.0.1:6379
JWT_SECRET             → Generate:  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
PAYSTACK_SECRET_KEY    → Paystack       → Settings → API Keys
PAYSTACK_PUBLIC_KEY    → Paystack       → Settings → API Keys
CLOUDINARY_CLOUD_NAME  → Cloudinary     → Dashboard
CLOUDINARY_API_KEY     → Cloudinary     → Dashboard
CLOUDINARY_API_SECRET  → Cloudinary     → Dashboard
SMTP_HOST              → Mailtrap       → Inbox → SMTP Settings
SMTP_USER              → Mailtrap       → Inbox → SMTP Settings
SMTP_PASS              → Mailtrap       → Inbox → SMTP Settings
ONESIGNAL_APP_ID       → OneSignal      → Settings → Keys & IDs
ONESIGNAL_REST_API_KEY → OneSignal      → Settings → Keys & IDs
GOOGLE_MAPS_API_KEY    → Google Cloud   → APIs & Services → Credentials
SENTRY_DSN             → Sentry         → Project → Settings → DSN
```

---

## Notes

- ⚠️ **Start Paystack KYC on Day 1** — requires CAC documents and takes several days to approve
- Use Paystack **test keys** (`sk_test_`) during development, switch to **live keys** after KYC approval
- iOS push notifications require an **Apple Developer account ($99/year)** — can skip for launch
- Google Maps requires a **billing account** but comes with $200 free monthly credit
- See `THIRD_PARTY_SERVICES.md` for detailed step-by-step instructions for each service
