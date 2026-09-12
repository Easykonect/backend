/**
 * withTransaction: retries MongoDB write conflicts, and nothing else
 */

import { GraphQLError } from 'graphql';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import prisma from '@/lib/prisma';
import { isWriteConflict, withTransaction } from '@/lib/transaction';

const transaction = prisma.$transaction as jest.Mock;

const knownError = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '5.22.0' });

const writeConflict = () =>
  knownError('P2034', 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction');

beforeEach(() => {
  transaction.mockReset();
});

describe('withTransaction', () => {
  it('runs the callback in a transaction with a timeout and returns its result', async () => {
    transaction.mockImplementation(async (run: (tx: string) => Promise<string>) => run('tx'));

    const result = await withTransaction(async (tx) => `ran with ${tx}`);

    expect(result).toBe('ran with tx');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });
  });

  it('runs the transaction again after a write conflict', async () => {
    transaction
      .mockRejectedValueOnce(writeConflict())
      .mockImplementationOnce(async (run: (tx: string) => Promise<string>) => run('tx'));

    await expect(withTransaction(async () => 'done')).resolves.toBe('done');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('recognises a write conflict reported only in the error message', async () => {
    transaction
      .mockRejectedValueOnce(new Error('Command failed with error 112 (WriteConflict)'))
      .mockImplementationOnce(async (run: (tx: string) => Promise<string>) => run('tx'));

    await expect(withTransaction(async () => 'done')).resolves.toBe('done');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after four attempts', async () => {
    transaction.mockRejectedValue(writeConflict());

    await expect(withTransaction(async () => 'never')).rejects.toMatchObject({ code: 'P2034' });
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['a business rule', new GraphQLError('Insufficient wallet balance', { extensions: { code: 'INSUFFICIENT_BALANCE' } })],
    ['a unique constraint', knownError('P2002', 'Unique constraint failed on the fields: (`reference`)')],
  ])('does not retry %s', async (_label, error) => {
    transaction.mockRejectedValue(error);

    await expect(withTransaction(async () => 'never')).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('isWriteConflict', () => {
  it.each([
    [writeConflict(), true],
    [new Error('TransientTransactionError: write conflict'), true],
    [knownError('P2002', 'Unique constraint failed'), false],
    [new GraphQLError('Wallet is locked'), false],
    ['not an error', false],
  ])('%#: returns %s', (error, expected) => {
    expect(isWriteConflict(error)).toBe(expected);
  });
});
