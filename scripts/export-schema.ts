/**
 * Schema Export Script
 * Exports GraphQL schema to SDL file for documentation
 */

import { printSchema, buildSchema } from 'graphql';
import { typeDefs } from '../src/graphql/schemas/index';
import * as fs from 'fs';
import * as path from 'path';

// Convert typeDefs to string
const schemaString = typeDefs.loc?.source.body || '';

// Write to file
const outputPath = path.join(__dirname, '..', 'schema.graphql');
fs.writeFileSync(outputPath, schemaString);

console.log('Schema exported to schema.graphql');
