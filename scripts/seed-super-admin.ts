/**
 * Super Admin Seeder
 * 
 * Creates the initial SUPER_ADMIN account directly in the database.
 * This is a one-time bootstrap script — run it ONCE on a fresh deployment.
 * 
 * Usage:
 *   npx ts-node --transpile-only scripts/seed-super-admin.ts
 * 
 * Required env vars: DATABASE_URL, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD,
 *                    SUPER_ADMIN_FIRST_NAME, SUPER_ADMIN_LAST_NAME, BCRYPT_SALT_ROUNDS
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true } as dotenv.DotenvConfigOptions & { quiet?: boolean });

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ==================
// Validated Config
// ==================
interface ValidatedConfig {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  bcryptRounds: number;
}

function validate(): ValidatedConfig {
  const email      = process.env.SUPER_ADMIN_EMAIL;
  const password   = process.env.SUPER_ADMIN_PASSWORD;
  const firstName  = process.env.SUPER_ADMIN_FIRST_NAME;
  const lastName   = process.env.SUPER_ADMIN_LAST_NAME;
  const roundsRaw  = process.env.BCRYPT_SALT_ROUNDS;

  if (!email) {
    console.error('❌ SUPER_ADMIN_EMAIL is required in your .env file');
    process.exit(1);
  }
  if (!password) {
    console.error('❌ SUPER_ADMIN_PASSWORD is required in your .env file');
    process.exit(1);
  }
  if (!firstName) {
    console.error('❌ SUPER_ADMIN_FIRST_NAME is required in your .env file');
    process.exit(1);
  }
  if (!lastName) {
    console.error('❌ SUPER_ADMIN_LAST_NAME is required in your .env file');
    process.exit(1);
  }
  if (!roundsRaw) {
    console.error('❌ BCRYPT_SALT_ROUNDS is required in your .env file');
    process.exit(1);
  }

  const bcryptRounds = parseInt(roundsRaw, 10);
  if (isNaN(bcryptRounds) || bcryptRounds < 10) {
    console.error('❌ BCRYPT_SALT_ROUNDS must be a number >= 10');
    process.exit(1);
  }

  const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;
  if (!strongPassword.test(password)) {
    console.error('❌ SUPER_ADMIN_PASSWORD must be at least 8 characters with uppercase, lowercase, number, and special character (!@#$%^&*)');
    process.exit(1);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error('❌ SUPER_ADMIN_EMAIL is not a valid email address');
    process.exit(1);
  }

  return { email, password, firstName, lastName, bcryptRounds };
}

// ==================
// Seed
// ==================
async function seed() {
  console.log('\n🔐 Super Admin Seeder');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { email, password, firstName, lastName, bcryptRounds } = validate();

  const normalizedEmail = email.toLowerCase().trim();

  // Check if already exists
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    if (existing.role === 'SUPER_ADMIN') {
      console.log(`⚠️  A SUPER_ADMIN already exists with email: ${normalizedEmail}`);
      console.log('   No changes made. Use the admin panel to manage accounts.');
    } else {
      console.log(`❌ An account with email ${normalizedEmail} already exists with role: ${existing.role}`);
      console.log('   Please use a different email for the Super Admin.');
    }
    await prisma.$disconnect();
    process.exit(0);
  }

  // Hash password
  console.log('⏳ Hashing password...');
  const hashedPassword = await bcrypt.hash(password, bcryptRounds);

  // Create super admin
  console.log('⏳ Creating Super Admin account...');
  const superAdmin = await prisma.user.create({
    data: {
      email: normalizedEmail,
      password: hashedPassword,
      firstName,
      lastName,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      isEmailVerified: true,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  console.log('\n✅ Super Admin created successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   ID:         ${superAdmin.id}`);
  console.log(`   Email:      ${superAdmin.email}`);
  console.log(`   Name:       ${superAdmin.firstName} ${superAdmin.lastName}`);
  console.log(`   Role:       ${superAdmin.role}`);
  console.log(`   Status:     ${superAdmin.status}`);
  console.log(`   Created:    ${superAdmin.createdAt.toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n🚀 You can now log in via the adminLogin mutation.');
  console.log('   Remove SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD from .env after seeding.\n');
}

seed()
  .catch((err) => {
    console.error('\n❌ Seeder failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
