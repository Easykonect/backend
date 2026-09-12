# Easykonnet — Setup Checklist

Everything needed to go live. Work top to bottom.

---

## On the Server

| What | Why |
|------|-----|
| **Node.js 22 LTS (22.12 or later)** | Runs the backend app. Node 20 is end-of-life, and sanitize-html needs 22.12+ |
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
BACKEND_URL            → Your API domain → https://api.easykonnet.com (Paystack returns mobile checkouts here)
APP_URL_SCHEMES        → The mobile app's URL schemes, comma-separated → easykonnect (checkout only returns to these)
COMMISSION_RATE        → Starting commission as a decimal → 0.07 for 7% (a Super Admin can change it in the app; each booking keeps the rate it was made at)
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
CLIENT_IP_HEADER       → Header the edge sets to each visitor's real IP → leave unset on Render (true-client-ip from Cloudflare is used automatically there). Elsewhere, only set it if a CDN in front of the app overwrites that header, or visitors could fake their IP
TRUSTED_PROXY_COUNT    → Proxies in front of the app that append to X-Forwarded-For, used when there's no CLIENT_IP_HEADER → default 1 (e.g. one Nginx). Too low lets visitors fake their IP; too high puts everyone on a proxy's IP, sharing one rate limit
RATE_LIMIT_READS_PER_MINUTE     → GraphQL queries per minute per signed-in user → default 300
RATE_LIMIT_WRITES_PER_MINUTE    → GraphQL mutations per minute per signed-in user → default 60
RATE_LIMIT_ANONYMOUS_PER_MINUTE → GraphQL requests per minute per IP without a valid access token → default 300 (everyone signed out behind one carrier IP shares it)
RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS → No longer used (replaced by the per-minute limits above); remove them
GRAPHQL_MAX_DEPTH, GRAPHQL_MAX_ROOT_FIELDS, GRAPHQL_MAX_ALIASES → Largest GraphQL request accepted → defaults 10, 20, 30. Raise one if the app's own screens get QUERY_TOO_COMPLEX
TERMS_VERSION          → Version of the community terms users accept → default 2026-09. Change it whenever the terms change, and everyone is asked to accept again
REQUIRE_TERMS_ACCEPTANCE → true or false (default false). Leave false until the app shows the terms screen and calls acceptTerms; when true, messages, reviews and new listings are refused until the current terms are accepted
CONTENT_FILTER_TERMS   → Extra words to block, comma-separated, on top of the built-in list (optional). Applies to messages, reviews, names and listings
AUTO_HIDE_REPORT_COUNT → Separate reports that hide a review's text until an admin decides → default 3
```

---

## Notes

- ⚠️ **Run the app with `npm run build:server && npm run start:ws` under PM2**, not `npm start`. Only the custom server runs the background jobs that pay providers after a job, check withdrawals with Paystack and request scheduled payouts.
- In Paystack, turn off OTP confirmation for transfers, or every withdrawal waits for someone to approve it in the dashboard
- Point the hosting platform's health check at `/api/health`. It answers 200 without touching the database or Redis.
- ⚠️ **Start Paystack KYC on Day 1** — requires CAC documents and takes several days to approve
- Use Paystack **test keys** (`sk_test_`) during development, switch to **live keys** after KYC approval
- iOS push notifications require an **Apple Developer account ($99/year)** — can skip for launch
- Google Maps requires a **billing account** but comes with $200 free monthly credit
- See `THIRD_PARTY_SERVICES.md` for detailed step-by-step instructions for each service
