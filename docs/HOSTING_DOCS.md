# Hosting GraphQL Documentation

Your GraphQL API documentation can be accessed in multiple ways:

## Option 1: Apollo Sandbox (Built-in, Already Live) ✅

The easiest way! Apollo Server automatically provides an interactive playground:

**URL**: https://backend-ehtm.onrender.com/api/graphql

Features:
- ✅ Interactive query builder
- ✅ Full schema exploration
- ✅ Test queries and mutations
- ✅ No additional setup needed

**Share this link with your frontend team!**

---

## Option 2: Generate Static HTML Documentation with SpectaQL

Generate beautiful static documentation that you can host anywhere:

### Generate Documentation

```bash
# Generate static HTML docs
npx spectaql spectaql.config.yml
```

This creates documentation in `./docs/api/` folder.

### Host Options:

#### A. **GitHub Pages** (Free, Recommended)

1. Generate docs:
   ```bash
   npx spectaql spectaql.config.yml
   ```

2. Commit and push:
   ```bash
   git add docs/api
   git commit -m "Add API documentation"
   git push origin main
   ```

3. Enable GitHub Pages:
   - Go to: https://github.com/Easykonect/backend/settings/pages
   - Source: Deploy from a branch
   - Branch: `main`, Folder: `/docs`
   - Save

4. Access at: `https://easykonect.github.io/backend/api/`

#### B. **Vercel/Netlify** (Free)

Deploy the `docs/api` folder:

**Vercel:**
```bash
cd docs/api
vercel --prod
```

**Netlify:**
```bash
cd docs/api
npx netlify deploy --prod
```

#### C. **Host on Same Server** (Your Render deployment)

Add this to your Next.js app:

1. Create `public/docs` folder:
   ```bash
   mkdir -p public/docs
   ```

2. Generate docs to public folder:
   ```bash
   # Update spectaql.config.yml targetDir to ./public/docs/api
   npx spectaql spectaql.config.yml
   ```

3. Access at: `https://backend-ehtm.onrender.com/docs/api/index.html`

---

## Option 3: GraphQL Playground (Alternative Interactive UI)

If you prefer GraphQL Playground over Apollo Sandbox:

1. Install:
   ```bash
   npm install graphql-playground-middleware-express
   ```

2. Add to your server setup (optional, Apollo Sandbox is already good)

---

## Recommendation for Your Frontend Team

**Use Apollo Sandbox for now**: https://backend-ehtm.onrender.com/api/graphql

It's already live, interactive, and requires zero setup!

**For static docs later**: Generate SpectaQL docs and host on GitHub Pages when you want a polished documentation site.

---

## Current Documentation Files

1. **QUICKSTART.md** - Quick integration guide for frontend devs
2. **FRONTEND_INTEGRATION.md** - Comprehensive API reference with examples
3. **Apollo Sandbox** - Interactive playground (already live)
4. **SpectaQL** - Can generate static HTML docs

Share the QUICKSTART.md with your frontend team to get started immediately! 🚀
