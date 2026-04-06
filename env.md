# CORS Configuration
SOCKET_CORS_ORIGIN="https://easykonnetadminapp.vercel.app,https://easykonnect-super-admin.vercel.app"
WEBSOCKET_CORS_ORIGINS="https://easykonnetadminapp.vercel.app,https://easykonnect-super-admin.vercel.app"



# Payment Configuration (add real keys when ready)
PAYSTACK_SECRET_KEY=""
PAYSTACK_PUBLIC_KEY=""

# Logging & Monitoring
LOG_LEVEL="info"                    # Options: debug, info, warn, error

# Sentry Error Monitoring (Optional but recommended for production)
# Get your DSN from: https://sentry.io → Project Settings → Client Keys
SENTRY_DSN=""                       # Example: https://abc123@o123456.ingest.sentry.io/1234567