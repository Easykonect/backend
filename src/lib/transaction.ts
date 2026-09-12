/**
 * Database transactions with retry
 *
 * MongoDB aborts one of two transactions that write the same document at the
 * same time (a write conflict). The aborted transaction wrote nothing, so money
 * operations run it again a few times before giving up.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

export type TransactionClient = Prisma.TransactionClient;

const MAX_ATTEMPTS = 4;
const TRANSACTION_TIMEOUT_MS = 15_000;

export const isWriteConflict = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /write conflict|WriteConflict|TransientTransactionError/i.test(message);
};

export const withTransaction = async <T>(
  run: (tx: TransactionClient) => Promise<T>
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, { timeout: TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isWriteConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 25));
    }
  }
};
