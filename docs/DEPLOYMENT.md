# EasyKonnect Backend Deployment Guide

## Deploying to Render

### Prerequisites
- GitHub account with your code pushed
- Render account (free at render.com)
- MongoDB Atlas database (you already have this)

---

## Step 1: Prepare Your Code

Make sure your code is pushed to GitHub:

```bash
git add .
git commit -m "Prepare for deployment"
git push origin main
```

---

## Step 2: Create Render Account

1. Go to https://render.com
2. Sign up with GitHub (recommended for easy deployment)

---

## Step 3: Create New Web Service

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository
3. Select the `easykonect` repository

---

## Step 4: Configure Build Settings

| Setting | Value |
|---------|-------|
| **Name** | `easykonect-api` |
| **Region** | Choose closest to your users |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install && npx prisma generate && npm run build` |
| **Start Command** | `npm start` |
| **Instance Type** | `Free` (or paid for production) |

---

## Step 5: Add Environment Variables

Click **"Environment"** and add these variables:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | `mongodb+srv://...` (your MongoDB connection string) |
| `JWT_SECRET` | `your-super-secret-key-min-32-chars` |
| `JWT_EXPIRES_IN` | `7d` |
| `JWT_REFRESH_EXPIRES_IN` | `30d` |
| `NODE_ENV` | `production` |
| `SMTP_HOST` | `smtp.hostinger.com` (or your email provider) |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` |
| `SMTP_USER` | `noreply@yourdomain.com` |
| `SMTP_PASS` | `your-email-password` |
| `EMAIL_FROM_NAME` | `EasyKonnect` |
| `EMAIL_FROM_ADDRESS` | `noreply@yourdomain.com` |

**⚠️ Important:** Generate a strong JWT_SECRET:
```bash
openssl rand -base64 32
```

---

## Step 6: Deploy

1. Click **"Create Web Service"**
2. Wait for build to complete (5-10 minutes first time)
3. Your API will be live at: `https://easykonect-api.onrender.com`

---

## Step 7: Test Your Deployment

Your GraphQL endpoint will be:
```
https://easykonect-api.onrender.com/api/graphql
```

Test with curl:
```bash
curl -X POST https://easykonect-api.onrender.com/api/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "mutation { register(input: { email: \"test@example.com\", password: \"SecurePass123!\", firstName: \"Test\", lastName: \"User\" }) { success message } }"}'
```

---

## Step 8: Update MongoDB Atlas Network Access

1. Go to MongoDB Atlas → Network Access
2. Click **"Add IP Address"**
3. Click **"Allow Access from Anywhere"** (0.0.0.0/0)
   - This is needed because Render uses dynamic IPs
   - For better security, use Render's static IPs (paid plan)

---

## Render Free Tier Limitations

| Aspect | Free Tier | Paid ($7/month) |
|--------|-----------|-----------------|
| **Spin Down** | After 15 min inactivity | Always on |
| **Cold Start** | ~30 seconds | None |
| **RAM** | 512 MB | 2 GB+ |
| **Bandwidth** | 100 GB/month | 100 GB/month |

**Note:** Free tier "spins down" after 15 minutes of no traffic. First request after spin-down takes ~30 seconds.

---

## Alternative: Deploy to Vercel (Also Free)

Since you're using Next.js, Vercel is another excellent option:

1. Go to https://vercel.com
2. Import your GitHub repository
3. Add environment variables
4. Deploy

Vercel is optimized for Next.js and has no cold start issues.

---

## Production Checklist

Before going live:

- [ ] Change `JWT_SECRET` to a strong random value
- [ ] Set `NODE_ENV=production`
- [ ] Configure production email (Hostinger, SendGrid, etc.)
- [ ] Enable MongoDB Atlas IP whitelist
- [ ] Set up custom domain (optional)
- [ ] Enable HTTPS (automatic on Render/Vercel)

---

## Custom Domain (Optional)

1. In Render dashboard, go to your service
2. Click **"Settings"** → **"Custom Domains"**
3. Add your domain: `api.easykonect.com`
4. Add the DNS records to your domain registrar
5. SSL certificate is automatic

Your API will then be available at:
```
https://api.easykonect.com/api/graphql
```
