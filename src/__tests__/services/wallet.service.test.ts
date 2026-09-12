/**
 * Wallet service: transaction history, ledger entries, stale locks, the daily
 * withdrawal total, a provider's pendingBalance and admin adjustments
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    wallet: { findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    withdrawal: { findMany: jest.fn() },
    serviceProvider: { findUnique: jest.fn() },
    payment: { aggregate: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ captureException: jest.fn(), captureWalletError: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn().mockResolvedValue(undefined) }));

import prisma from '@/lib/prisma';
import type { TransactionClient } from '@/lib/transaction';
import {
  adjustWalletBalance,
  applyWalletCredit,
  applyWalletDebit,
  getDailyWithdrawalTotal,
  getOrCreateWallet,
  getWalletTransactions,
  unlockStaleWallets,
} from '@/services/wallet.service';

describe('getWalletTransactions', () => {
  it('filters by wallet, accepts the old source names and returns the paginated shape', async () => {
    (prisma.walletTransaction.findMany as jest.Mock).mockResolvedValue([
      {
        id: 't1',
        walletId: 'wallet1',
        type: 'CREDIT',
        source: 'SERVICE_EARNING',
        amount: 558_000,
        balanceBefore: 0,
        balanceAfter: 558_000,
        description: 'Earnings from booking',
        reference: 'ERN_1',
        createdAt: new Date(),
      },
    ]);
    (prisma.walletTransaction.count as jest.Mock).mockResolvedValue(1);

    const legacyFilter = { source: 'EARNING' } as unknown as Parameters<typeof getWalletTransactions>[1];
    const result = await getWalletTransactions('wallet1', legacyFilter, { page: 1, limit: 10 });

    const where = (prisma.walletTransaction.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ walletId: 'wallet1', source: 'SERVICE_EARNING' });
    expect(result).toMatchObject({ total: 1, page: 1, hasNextPage: false });
    expect(result.items[0]).toMatchObject({ amount: 5580, referenceId: 'ERN_1' });
  });
});

// A transaction client with no ledger entries yet; create echoes the entry
const makeTx = () => {
  const tx = {
    wallet: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    walletTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'txn-new', ...data })),
    },
  };
  return { tx, client: tx as unknown as TransactionClient };
};

describe('applyWalletDebit', () => {
  const debit = {
    walletId: 'wallet1',
    amount: 600_000,
    source: 'BOOKING_PAYMENT' as const,
    description: 'Payment for Deep Cleaning',
    reference: 'WPAY_booking1',
    bookingId: 'booking1',
  };

  it('decrements only an unlocked wallet holding the amount, and records the balances', async () => {
    const { tx, client } = makeTx();
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUnique.mockResolvedValue({ id: 'wallet1', balance: 400_000, isLocked: false });

    await applyWalletDebit(client, debit);

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'wallet1', balance: { gte: 600_000 }, isLocked: false },
      data: { balance: { decrement: 600_000 } },
    });
    expect(tx.walletTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'DEBIT',
      amount: 600_000,
      balanceBefore: 1_000_000,
      balanceAfter: 400_000,
      reference: 'WPAY_booking1',
    });
  });

  it('ignores the lock only when allowLocked is set', async () => {
    const { tx, client } = makeTx();
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUnique.mockResolvedValue({ id: 'wallet1', balance: 0, isLocked: true });

    await applyWalletDebit(client, { ...debit, allowLocked: true });

    expect(tx.wallet.updateMany.mock.calls[0][0].where).toEqual({ id: 'wallet1', balance: { gte: 600_000 } });
  });

  it('throws WALLET_LOCKED when the wallet is locked', async () => {
    const { tx, client } = makeTx();
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });
    tx.wallet.findUnique.mockResolvedValue({ id: 'wallet1', balance: 1_000_000, isLocked: true, lockedReason: 'Pending withdrawal' });

    await expect(applyWalletDebit(client, debit)).rejects.toMatchObject({ extensions: { code: 'WALLET_LOCKED' } });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('throws INSUFFICIENT_BALANCE when the balance is short', async () => {
    const { tx, client } = makeTx();
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });
    tx.wallet.findUnique.mockResolvedValue({ id: 'wallet1', balance: 599_999, isLocked: false });

    await expect(applyWalletDebit(client, debit)).rejects.toMatchObject({ extensions: { code: 'INSUFFICIENT_BALANCE' } });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('returns the entry already written for the reference without moving money', async () => {
    const { tx, client } = makeTx();
    const existing = { id: 'txn-1', walletId: 'wallet1', type: 'DEBIT', amount: 600_000, reference: 'WPAY_booking1' };
    tx.walletTransaction.findUnique.mockResolvedValue(existing);

    await expect(applyWalletDebit(client, debit)).resolves.toBe(existing);

    expect(tx.walletTransaction.findUnique).toHaveBeenCalledWith({ where: { reference: 'WPAY_booking1' } });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('throws DUPLICATE_REFERENCE when the reference was used for a different amount', async () => {
    const { tx, client } = makeTx();
    tx.walletTransaction.findUnique.mockResolvedValue({ id: 'txn-1', walletId: 'wallet1', type: 'DEBIT', amount: 500_000, reference: 'WPAY_booking1' });

    await expect(applyWalletDebit(client, debit)).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_REFERENCE' } });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });
});

describe('applyWalletCredit', () => {
  const credit = {
    walletId: 'wallet1',
    amount: 558_000,
    source: 'SERVICE_EARNING' as const,
    description: 'Earnings from booking',
    reference: 'ERN_pay1',
    paymentId: 'pay1',
  };

  it('records the balance before and after from the updated wallet', async () => {
    const { tx, client } = makeTx();
    tx.wallet.update.mockResolvedValue({ id: 'wallet1', balance: 1_558_000 });

    await applyWalletCredit(client, credit);

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet1' }, data: { balance: { increment: 558_000 } } });
    expect(tx.walletTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'CREDIT',
      amount: 558_000,
      balanceBefore: 1_000_000,
      balanceAfter: 1_558_000,
    });
  });

  it('throws BALANCE_OVERFLOW when the balance would pass 2,000,000,000 kobo', async () => {
    const { tx, client } = makeTx();
    tx.wallet.update.mockResolvedValue({ id: 'wallet1', balance: 2_000_000_001 });

    await expect(applyWalletCredit(client, credit)).rejects.toMatchObject({ extensions: { code: 'BALANCE_OVERFLOW' } });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });
});

describe('unlockStaleWallets', () => {
  it('unlocks only locked wallets with no pending or processing withdrawal', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (prisma.wallet.findMany as jest.Mock).mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([{ walletId: 'w2' }]);
    (prisma.wallet.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

    await expect(unlockStaleWallets()).resolves.toBe(2);

    expect((prisma.wallet.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({ isLocked: true });
    expect((prisma.withdrawal.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      walletId: { in: ['w1', 'w2', 'w3'] },
      status: { in: ['PENDING', 'PROCESSING'] },
    });
    expect(prisma.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['w1', 'w3'] }, isLocked: true },
      data: { isLocked: false, lockedReason: null },
    });
  });

  it('leaves a lock that still has an open withdrawal', async () => {
    (prisma.wallet.findMany as jest.Mock).mockResolvedValue([{ id: 'w1' }]);
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([{ walletId: 'w1' }]);

    await expect(unlockStaleWallets()).resolves.toBe(0);
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled();
  });
});

describe('getDailyWithdrawalTotal', () => {
  beforeEach(() => {
    (prisma.walletTransaction.aggregate as jest.Mock).mockImplementation(async ({ where }: { where: { source: string } }) => ({
      _sum: { amount: where.source === 'WITHDRAWAL' ? 800_000 : 300_000 },
    }));
  });

  afterEach(() => jest.useRealTimers());

  // The day starts at midnight in Lagos (UTC+1), whatever the server's timezone
  it.each([
    ['00:30 on 12 September in Lagos', '2026-09-11T23:30:00Z', '2026-09-11T23:00:00.000Z'],
    ['23:30 on 11 September in Lagos', '2026-09-11T22:30:00Z', '2026-09-10T23:00:00.000Z'],
  ])('subtracts today’s withdrawal reversals from today’s withdrawals at %s', async (_lagosTime, instant, startOfDay) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(instant));

    await expect(getDailyWithdrawalTotal('user1')).resolves.toBe(500_000);

    const since = { gte: new Date(startOfDay) };
    const wheres = (prisma.walletTransaction.aggregate as jest.Mock).mock.calls.map(([args]) => args.where);
    expect(wheres).toHaveLength(2);
    expect(wheres).toEqual(expect.arrayContaining([
      { wallet: { userId: 'user1' }, type: 'DEBIT', source: 'WITHDRAWAL', createdAt: since },
      { wallet: { userId: 'user1' }, type: 'CREDIT', source: 'WITHDRAWAL_REVERSAL', createdAt: since },
    ]));
  });
});

describe('getOrCreateWallet — pendingBalance', () => {
  const stored = {
    id: 'wallet1',
    userId: 'user1',
    balance: 250_000,
    pendingBalance: 0,
    currency: 'NGN',
    isLocked: false,
    lockedReason: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-10T10:00:00Z'),
  };

  beforeEach(() => {
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(stored);
  });

  it('shows a provider’s share of paid bookings still held in escrow', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ id: 'provider1' });
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { providerPayout: 13_950.5 } });

    const wallet = await getOrCreateWallet('user1');

    expect(prisma.serviceProvider.findUnique).toHaveBeenCalledWith({ where: { userId: 'user1' }, select: { id: true } });
    // Paid, and neither released to the wallet nor paid out before walletTransactionId was recorded
    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: {
        booking: { providerId: 'provider1' },
        status: 'COMPLETED',
        AND: [
          { OR: [{ payoutAt: null }, { payoutAt: { isSet: false } }] },
          { OR: [{ walletTransactionId: null }, { walletTransactionId: { isSet: false } }] },
        ],
      },
      _sum: { providerPayout: true },
    });
    expect(wallet).toMatchObject({ balance: 2_500, pendingBalance: 13_950.5, pendingBalanceKobo: 1_395_050 });
  });

  it('is 0 when nothing is held', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ id: 'provider1' });
    (prisma.payment.aggregate as jest.Mock).mockResolvedValue({ _sum: { providerPayout: null } });

    await expect(getOrCreateWallet('user1')).resolves.toMatchObject({ pendingBalance: 0 });
  });

  it('is 0 for a customer, without reading payments', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    const wallet = await getOrCreateWallet('user1');

    expect(prisma.payment.aggregate).not.toHaveBeenCalled();
    expect(wallet.pendingBalance).toBe(0);
  });
});

describe('adjustWalletBalance', () => {
  const adjust = (userId = 'user1', amountKobo = 250_000) =>
    adjustWalletBalance(userId, amountKobo, 'CREDIT', 'Compensation for a late arrival', 'admin1', 'SUPER_ADMIN');

  it('refuses an account that doesn’t exist, before creating a wallet', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(adjust()).rejects.toMatchObject({ message: 'User not found', extensions: { code: 'NOT_FOUND' } });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user1' }, select: { id: true, role: true } });
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.wallet.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('refuses a %s account', async (role) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'user1', role });

    await expect(adjust()).rejects.toMatchObject({
      message: 'Wallet adjustments can only be made to customer and provider accounts',
      extensions: { code: 'FORBIDDEN' },
    });

    expect(prisma.wallet.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('checks the amount before looking the user up', async () => {
    await expect(adjust('user1', 100_000_001)).rejects.toMatchObject({ extensions: { code: 'ADJUSTMENT_LIMIT_EXCEEDED' } });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('credits a customer’s wallet', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'user1', role: 'SERVICE_USER' });
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ id: 'wallet1', userId: 'user1', balance: 0 });
    const { tx, client } = makeTx();
    tx.wallet.update.mockResolvedValue({ id: 'wallet1', balance: 250_000 });
    tx.walletTransaction.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'txn-adj',
      createdAt: new Date(),
      ...data,
    }));
    (prisma.$transaction as jest.Mock).mockImplementation(async (run: (tx: TransactionClient) => unknown) => run(client));

    const result = await adjust();

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet1' }, data: { balance: { increment: 250_000 } } });
    expect(result).toMatchObject({ type: 'CREDIT', source: 'ADMIN_ADJUSTMENT', amount: 2_500, adjustedBy: 'admin1' });
  });
});
