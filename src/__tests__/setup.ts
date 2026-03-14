/**
 * Jest Global Setup
 * Loads environment variables from .env file before tests run
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from the project root
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath, quiet: true } as dotenv.DotenvConfigOptions & { quiet?: boolean });
