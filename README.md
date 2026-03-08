# EasyKonnect Backend API

A professional service marketplace backend API where users can book services, and service providers can list their services.

## 📋 Table of Contents

- [About](#about)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Running the Application](#running-the-application)
- [Project Structure](#project-structure)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)

## About

EasyKonnect is a service marketplace platform that connects service providers (plumbers, electricians, carpenters, etc.) with customers who need their services. The platform operates on a commission-based model.

### Key Features

- **Service Providers**: List, manage, and update services
- **Service Users**: Browse, request, and pay for services
- **Admin Panel**: Manage users, approve providers, handle disputes
- **Super-Admin**: Full platform control and configuration

### User Roles

| Role | Description |
|------|-------------|
| Service User | Customers who browse and book services |
| Service Provider | Professionals offering services |
| Admin | Platform operators managing day-to-day operations |
| Super-Admin | Highest-level access with full platform control |

## Tech Stack

| Technology | Purpose |
|------------|---------|
| [Next.js](https://nextjs.org/) | Backend framework with API routes |
| [TypeScript](https://www.typescriptlang.org/) | Type-safe JavaScript |
| [GraphQL](https://graphql.org/) | API query language |
| [Apollo Server](https://www.apollographql.com/docs/apollo-server/) | GraphQL server |
| [Prisma](https://www.prisma.io/) | Database ORM |
| [MongoDB](https://www.mongodb.com/) | Database |
| [JWT](https://jwt.io/) | Authentication |
| [Zod](https://zod.dev/) | Data validation |

## Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/) (v9 or higher)
- [MongoDB](https://www.mongodb.com/) (local or Atlas cloud)

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-org/easykonect.git
   cd easykonect
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` with your configuration (see [Environment Variables](#environment-variables))

4. **Generate Prisma Client**

   ```bash
   npx prisma generate
   ```

5. **Push database schema**

   ```bash
   npx prisma db push
   ```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Database
DATABASE_URL="mongodb+srv://username:password@cluster.mongodb.net/easykonect"

# Authentication
JWT_SECRET="your-super-secret-jwt-key"
JWT_EXPIRES_IN="7d"

# Application
NODE_ENV="development"
PORT=3000
```

> ⚠️ **Never commit your `.env` file to version control!**

## Running the Application

### Development

```bash
npm run dev
```

The GraphQL API will be available at `http://localhost:3000/api/graphql`

### Production

```bash
npm run build
npm start
```

### Other Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npx prisma studio` | Open Prisma database GUI |
| `npx prisma generate` | Generate Prisma Client |
| `npx prisma db push` | Push schema changes to database |

## Project Structure

```
easykonect/
├── docs/                    # Documentation
│   └── UX_DOCUMENTATION.md  # User experience documentation
├── prisma/
│   └── schema.prisma        # Database schema
├── src/
│   ├── app/
│   │   └── api/
│   │       └── graphql/     # GraphQL API endpoint
│   ├── graphql/
│   │   ├── resolvers/       # GraphQL resolvers
│   │   ├── schemas/         # GraphQL type definitions
│   │   └── index.ts         # GraphQL configuration
│   ├── lib/
│   │   ├── prisma.ts        # Prisma client instance
│   │   └── auth.ts          # Authentication utilities
│   ├── services/            # Business logic
│   ├── utils/               # Utility functions
│   └── types/               # TypeScript type definitions
├── .env                     # Environment variables (not in git)
├── .env.example             # Example environment variables
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
└── README.md                # This file
```

## API Documentation

### GraphQL Endpoint

```
POST /api/graphql
```

### GraphQL Playground

In development, visit `http://localhost:3000/api/graphql` to access the GraphQL Playground where you can:

- Explore the schema
- Test queries and mutations
- View documentation

### Example Queries

```graphql
# Get all services
query {
  services {
    id
    name
    price
    provider {
      name
    }
  }
}

# Create a booking
mutation {
  createBooking(input: {
    serviceId: "123"
    date: "2026-03-15"
  }) {
    id
    status
  }
}
```

> 📖 Full API documentation will be available in `docs/API.md`

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## License

This project is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.

---

**EasyKonnect** - Connecting Services, Simplifying Lives.
