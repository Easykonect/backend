/**
 * Withdrawal service: requests, processing, transfer outcomes, reconciliation
 * and list responses
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    withdrawal: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    wallet: { findUnique: jest.fn() },
    walletTransaction: { aggregate: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    serviceProvider: { findUnique: jest.fn() },
    providerBankAccount: { findFirst: jest.fn(), update: jest.fn() },
    scheduledPayout: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/paystack', () => ({
  ...jest.requireActual('@/lib/paystack'),
  paystack: {
    initiateTransfer: jest.fn(),
    verifyTransfer: jest.fn(),
    fetchTransfer: jest.fn(),
    createTransferRecipient: jest.fn(),
  },
}));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ captureException: jest.fn(), captureWalletError: jest.fn() }));
jest.mock('@/services/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/services/notification.service', () => ({
  createNotification: jest.fn(),
  createBulkNotifications: jest.fn(),
}));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));

import { AdminAction, type Withdrawal } from '@prisma/client';
import prisma from '@/lib/prisma';
import { paystack, PaystackRequestError, type PaystackTransferResponse } from '@/lib/paystack';
import { captureException } from '@/lib/sentry';
import { createAuditLog } from '@/services/audit.service';
import { createBulkNotifications, createNotification } from '@/services/notification.service';
import { sendPushToUser } from '@/services/push.service';
import {
  getProviderWithdrawals,
  handleTransferFailed,
  handleTransferReversed,
  handleTransferSuccess,
  MIN_WITHDRAWAL_NAIRA,
  processWithdrawal,
  reconcileProcessingWithdrawals,
  requestWithdrawal,
  retryWithdrawal,
  TRANSFER_FEE_KOBO,
} from '@/services/withdrawal.service';

const WITHDRAWAL_ID = '66e2b4c1f0a9d83b5c7e1a24';
const WALLET_ID = '66e2b4c1f0a9d83b5c7e1a25';
const PROVIDER_ID = '66e2b4c1f0a9d83b5c7e1a26';
const USER_ID = '66e2b4c1f0a9d83b5c7e1a27';
const ADMIN_ID = '66e2b4c1f0a9d83b5c7e1a28';
const SUPER_ADMIN_ID = '66e2b4c1f0a9d83b5c7e1a29';
const SCHEDULED_PAYOUT_ID = '66e2b4c1f0a9d83b5c7e1a32';

const DAY_MS = 24 * 60 * 60 * 1000;

const admins = [{ id: ADMIN_ID }, { id: SUPER_ADMIN_ID }];
const activeAccount = { bannedAt: null, bannedUntil: null, restrictedAt: null, restrictedUntil: null };

const attemptReference = (attempt: number) => `wdr_${WITHDRAWAL_ID}_${attempt}`;

const makeWithdrawal = (overrides: Partial<Withdrawal> = {}): Withdrawal => ({
  id: WITHDRAWAL_ID,
  walletId: WALLET_ID,
  providerId: PROVIDER_ID,
  amount: 500_000,
  fee: 5_000,
  netAmount: 495_000,
  status: 'PENDING',
  bankCode: '058',
  bankName: 'Guaranty Trust Bank',
  accountNumber: '0123456789',
  accountName: 'ADA OBI',
  transferCode: null,
  transferReference: 'wdr_req_3f9c2d7a1b8e4f6a9c0d2e5b7a1c3d4e',
  requestedAt: new Date(),
  processedAt: null,
  completedAt: null,
  failureReason: null,
  retryCount: 0,
  lastRetryAt: null,
  processedBy: null,
  scheduledPayoutId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const processingAttempt = (attempt: number, overrides: Partial<Withdrawal> = {}) =>
  makeWithdrawal({
    status: 'PROCESSING',
    retryCount: attempt,
    transferReference: attemptReference(attempt),
    processedAt: new Date(),
    processedBy: ADMIN_ID,
    ...overrides,
  });

const makeWallet = (balance: number, isLocked: boolean) => ({
  id: WALLET_ID,
  userId: USER_ID,
  balance,
  pendingBalance: 0,
  currency: 'NGN',
  isLocked,
  lockedReason: isLocked ? 'Pending withdrawal' : null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const transferResponse = (
  status: PaystackTransferResponse['data']['status'],
  transferCode: string,
  reference: string
): PaystackTransferResponse => ({
  status: true,
  message: 'Transfer retrieved',
  data: {
    integration: 100_032,
    domain: 'test',
    amount: 495_000,
    currency: 'NGN',
    source: 'balance',
    reason: `Easykonnet withdrawal ${WITHDRAWAL_ID}`,
    recipient: 28_512_873,
    status,
    reference,
    transfer_code: transferCode,
    id: 476_948,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

const notFound = () => new PaystackRequestError('Paystack request failed: Transfer not found', 404);
const timedOut = () =>
  new PaystackRequestError('Paystack request failed: The operation was aborted due to timeout');
const serverError = () => new PaystackRequestError('Paystack request failed: Paystack API error: 502', 502);
const rejectedByPaystack = () =>
  new PaystackRequestError('Paystack request failed: Your balance is not enough to fulfil this request', 400);

// Transaction client. The wallet holds ₦6,000: the ₦5,000 debit leaves
// ₦1,000 and a refund brings it back to ₦6,000.
const makeTx = () => ({
  withdrawal: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(),
  },
  wallet: {
    update: jest.fn().mockResolvedValue(makeWallet(600_000, true)),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue(makeWallet(100_000, true)),
  },
  walletTransaction: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  },
});

type Tx = ReturnType<typeof makeTx>;
let tx: Tx;

const ledgerEntries = () =>
  (tx.walletTransaction.create.mock.calls as [{ data: Record<string, unknown> }][]).map(([args]) => args.data);

beforeEach(() => {
  // clearMocks keeps implementations, so a rejection set in one test would leak
  jest.resetAllMocks();
  tx = makeTx();
  (prisma.$transaction as jest.Mock).mockImplementation(
    async (run: (client: Tx) => Promise<unknown>) => run(tx)
  );
  (prisma.walletTransaction.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });
  (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ id: PROVIDER_ID, userId: USER_ID });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue(activeAccount);
  (prisma.user.findMany as jest.Mock).mockResolvedValue(admins);
});

describe('processWithdrawal', () => {
  // A retry, so the attempt number can't be mistaken for a default of 0
  const ATTEMPT = 1;
  const reference = attemptReference(ATTEMPT);

  beforeEach(() => {
    (prisma.withdrawal.findUnique as jest.Mock).mockResolvedValue({
      ...makeWithdrawal({
        retryCount: ATTEMPT,
        transferReference: attemptReference(0),
        failureReason: 'Could not resolve account',
        lastRetryAt: new Date(),
      }),
      wallet: makeWallet(600_000, true),
    });
    (prisma.withdrawal.findUniqueOrThrow as jest.Mock).mockResolvedValue(processingAttempt(ATTEMPT));
    // Attempt 0 failed and its debit was returned
    (prisma.walletTransaction.findUnique as jest.Mock).mockResolvedValue({ id: '66e2b4c1f0a9d83b5c7e1a40' });
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'bank1', recipientCode: 'RCP_1' });
    (paystack.initiateTransfer as jest.Mock).mockResolvedValue(transferResponse('pending', 'TRF_1', reference));
    // What a reversal would find, so a wrongly taken refund path shows up
    tx.withdrawal.findUnique.mockResolvedValue(processingAttempt(ATTEMPT));
  });

  it('claims the withdrawal for the current attempt before any money moves', async () => {
    await processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN');

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PENDING', retryCount: ATTEMPT },
      data: expect.objectContaining({ status: 'PROCESSING', processedBy: ADMIN_ID, transferReference: reference }),
    });
    const [claimed] = tx.withdrawal.updateMany.mock.invocationCallOrder;
    expect(claimed).toBeLessThan(tx.wallet.updateMany.mock.invocationCallOrder[0]);
    expect(claimed).toBeLessThan((paystack.initiateTransfer as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('throws INVALID_STATUS without debiting or calling Paystack when the claim matches nothing', async () => {
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });

    await expect(processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      extensions: { code: 'INVALID_STATUS' },
    });

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('debits the locked wallet under the attempt reference and sends the net amount to Paystack', async () => {
    await processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN');

    // No isLocked condition: this withdrawal holds the lock
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: WALLET_ID, balance: { gte: 500_000 } },
      data: { balance: { decrement: 500_000 } },
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({
        type: 'DEBIT',
        source: 'WITHDRAWAL',
        amount: 500_000,
        balanceBefore: 600_000,
        balanceAfter: 100_000,
        reference: `WDR_TXN_${WITHDRAWAL_ID}_${ATTEMPT}`,
        withdrawalId: WITHDRAWAL_ID,
      }),
    ]);
    expect(paystack.initiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 495_000, recipient: 'RCP_1', reference })
    );
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, transferReference: reference },
      data: { transferCode: 'TRF_1' },
    });
  });

  it('writes the audit log after the debit and before starting the transfer, even when starting it fails', async () => {
    (paystack.initiateTransfer as jest.Mock).mockRejectedValue(timedOut());
    (paystack.verifyTransfer as jest.Mock).mockRejectedValue(notFound());

    await expect(processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      extensions: { code: 'TRANSFER_UNCONFIRMED' },
    });

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAction.PROCESS_WITHDRAWAL,
        targetId: WITHDRAWAL_ID,
        performedBy: ADMIN_ID,
        newValue: { status: 'PROCESSING', reference, attempt: ATTEMPT },
      })
    );
    const [audited] = (createAuditLog as jest.Mock).mock.invocationCallOrder;
    expect(audited).toBeGreaterThan(tx.walletTransaction.create.mock.invocationCallOrder[0]);
    expect(audited).toBeLessThan((paystack.initiateTransfer as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('keeps the withdrawal processing when starting the transfer errors but Paystack has it', async () => {
    (paystack.initiateTransfer as jest.Mock).mockRejectedValue(timedOut());
    (paystack.verifyTransfer as jest.Mock).mockResolvedValue(transferResponse('pending', 'TRF_2', reference));

    await processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN');

    expect(paystack.verifyTransfer).toHaveBeenCalledWith(reference);
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, transferReference: reference },
      data: { transferCode: 'TRF_2' },
    });
    expect(tx.withdrawal.updateMany).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toEqual([expect.objectContaining({ type: 'DEBIT' })]);
  });

  it('returns the debit and puts the withdrawal back to pending when Paystack rejected the transfer and has no record of it', async () => {
    (paystack.initiateTransfer as jest.Mock).mockRejectedValue(rejectedByPaystack());
    (paystack.verifyTransfer as jest.Mock).mockRejectedValue(notFound());

    await expect(processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
      extensions: { code: 'TRANSFER_FAILED' },
    });

    expect(tx.withdrawal.updateMany).toHaveBeenLastCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: ATTEMPT },
      data: expect.objectContaining({ status: 'PENDING', retryCount: ATTEMPT + 1, transferCode: null }),
    });
    // Who processed the attempt stays on record
    const reversal = (tx.withdrawal.updateMany.mock.lastCall as [{ data: Record<string, unknown> }])[0].data;
    expect(reversal).not.toHaveProperty('processedBy');
    expect(reversal).not.toHaveProperty('processedAt');
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ type: 'DEBIT', reference: `WDR_TXN_${WITHDRAWAL_ID}_${ATTEMPT}` }),
      expect.objectContaining({
        type: 'CREDIT',
        source: 'WITHDRAWAL_REVERSAL',
        amount: 500_000,
        balanceBefore: 100_000,
        balanceAfter: 600_000,
        reference: `WDR_REV_${WITHDRAWAL_ID}_${ATTEMPT}`,
        withdrawalId: WITHDRAWAL_ID,
      }),
    ]);
    expect(tx.wallet.update).toHaveBeenLastCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: true, lockedReason: 'Transfer failed - pending review' },
    });
    // Not the last attempt: it waits for review, without telling the provider
    expect(createNotification).not.toHaveBeenCalled();
    expect(prisma.scheduledPayout.update).not.toHaveBeenCalled();
  });

  it.each([
    // After a timeout or server error the transfer may still be created
    ['a timeout', 'a 404', timedOut(), notFound()],
    ['a Paystack server error', 'a 404', serverError(), notFound()],
    ['a timeout', 'a Paystack server error', timedOut(), serverError()],
    ['a rejection', 'a timeout', rejectedByPaystack(), timedOut()],
  ])(
    'refunds nothing and throws TRANSFER_UNCONFIRMED when starting fails with %s and the lookup with %s',
    async (_start, _lookup, startError, lookupError) => {
      (paystack.initiateTransfer as jest.Mock).mockRejectedValue(startError);
      (paystack.verifyTransfer as jest.Mock).mockRejectedValue(lookupError);

      await expect(processWithdrawal(WITHDRAWAL_ID, ADMIN_ID, 'ADMIN')).rejects.toMatchObject({
        extensions: { code: 'TRANSFER_UNCONFIRMED' },
      });

      expect(ledgerEntries()).toEqual([expect.objectContaining({ type: 'DEBIT' })]);
      expect(tx.withdrawal.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: WITHDRAWAL_ID, status: 'PROCESSING', transferReference: reference },
        data: { failureReason: expect.stringContaining('Transfer status unknown') },
      });
      expect(captureException).toHaveBeenCalled();
    }
  );

  it.each([
    ['banned', { bannedAt: new Date(Date.now() - DAY_MS), bannedUntil: null }],
    ['restricted', { restrictedAt: new Date(Date.now() - DAY_MS), restrictedUntil: new Date(Date.now() + DAY_MS) }],
  ])('refuses a %s provider before claiming, debiting or calling Paystack', async (_label, flags) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...activeAccount, ...flags });

    await expect(processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      message:
        'The provider’s account is banned or restricted, so this withdrawal can’t be processed. Reject it, or process it once the restriction ends.',
      extensions: { code: 'PROVIDER_RESTRICTED' },
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { bannedAt: true, bannedUntil: true, restrictedAt: true, restrictedUntil: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paystack.createTransferRecipient).not.toHaveBeenCalled();
    expect(paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('processes the withdrawal once a ban has ended', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...activeAccount,
      bannedAt: new Date(Date.now() - 10 * DAY_MS),
      bannedUntil: new Date(Date.now() - DAY_MS),
    });

    await processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN');

    expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
  });

  it('refuses a retry whose last failed attempt was never returned to the wallet', async () => {
    // Put back to PENDING by the earlier process, which kept the debit
    (prisma.walletTransaction.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'MANUAL_REVIEW_REQUIRED' },
    });

    expect(prisma.walletTransaction.findUnique).toHaveBeenCalledWith({
      where: { reference: `WDR_REV_${WITHDRAWAL_ID}_0` },
      select: { id: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('doesn’t look for an earlier reversal on the first attempt', async () => {
    (prisma.withdrawal.findUnique as jest.Mock).mockResolvedValue({
      ...makeWithdrawal(),
      wallet: makeWallet(600_000, true),
    });
    (prisma.walletTransaction.findUnique as jest.Mock).mockResolvedValue(null);
    (paystack.initiateTransfer as jest.Mock).mockResolvedValue(transferResponse('pending', 'TRF_0', attemptReference(0)));

    await processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN');

    expect(prisma.walletTransaction.findUnique).not.toHaveBeenCalled();
    expect(paystack.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ reference: attemptReference(0) }));
  });

  it('reports the remaining daily limit in naira, and changes nothing', async () => {
    // ₦4,998,000 already withdrawn today leaves ₦2,000
    (prisma.walletTransaction.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: 499_800_000 } })
      .mockResolvedValueOnce({ _sum: { amount: null } });

    await expect(processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      message: expect.stringContaining('Daily withdrawal limit reached'),
      extensions: { code: 'DAILY_LIMIT_EXCEEDED', remainingLimit: 2_000 },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('processWithdrawal on the 5th attempt', () => {
  const LAST = 4;

  beforeEach(() => {
    (prisma.withdrawal.findUnique as jest.Mock).mockResolvedValue({
      ...makeWithdrawal({
        retryCount: LAST,
        transferReference: attemptReference(LAST - 1),
        failureReason: 'Transfer failed',
        scheduledPayoutId: SCHEDULED_PAYOUT_ID,
      }),
      wallet: makeWallet(600_000, true),
    });
    (prisma.walletTransaction.findUnique as jest.Mock).mockResolvedValue({ id: '66e2b4c1f0a9d83b5c7e1a41' });
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'bank1', recipientCode: 'RCP_1' });
    (prisma.scheduledPayout.update as jest.Mock).mockResolvedValue({});
    (paystack.initiateTransfer as jest.Mock).mockRejectedValue(rejectedByPaystack());
    (paystack.verifyTransfer as jest.Mock).mockRejectedValue(notFound());
    tx.withdrawal.findUnique.mockResolvedValue(processingAttempt(LAST, { scheduledPayoutId: SCHEDULED_PAYOUT_ID }));
  });

  it('fails it, refunds it, updates its scheduled payout and tells the provider when Paystack refuses to start it', async () => {
    await expect(processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'TRANSFER_FAILED' },
    });

    expect(tx.withdrawal.updateMany).toHaveBeenLastCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: LAST },
      data: expect.objectContaining({ status: 'FAILED', failureReason: expect.stringContaining('Failed after 5 attempts') }),
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ type: 'DEBIT', reference: `WDR_TXN_${WITHDRAWAL_ID}_${LAST}` }),
      expect.objectContaining({ type: 'CREDIT', amount: 500_000, reference: `WDR_REV_${WITHDRAWAL_ID}_${LAST}` }),
    ]);
    expect(tx.wallet.update).toHaveBeenLastCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: false, lockedReason: null },
    });
    expect(prisma.scheduledPayout.update).toHaveBeenCalledWith({
      where: { id: SCHEDULED_PAYOUT_ID },
      data: {
        status: 'FAILED',
        processedAt: expect.any(Date),
        failureReason: 'Paystack request failed: Your balance is not enough to fulfil this request',
      },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: 'PAYMENT_FAILED', title: 'Withdrawal Failed' })
    );
    expect(sendPushToUser).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ title: 'Withdrawal Failed' }));
  });

  it('still reports TRANSFER_FAILED when telling the provider fails', async () => {
    (prisma.serviceProvider.findUnique as jest.Mock).mockRejectedValue(new Error('Connection reset'));

    await expect(processWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      extensions: { code: 'TRANSFER_FAILED' },
    });
    expect(captureException).toHaveBeenCalled();
  });
});

describe('retryWithdrawal', () => {
  it.each([
    ['a FAILED withdrawal', makeWithdrawal({ status: 'FAILED', retryCount: 4, transferReference: attemptReference(4) })],
    ['a withdrawal never attempted', makeWithdrawal()],
  ])('refuses %s without moving money', async (_label, withdrawal) => {
    (prisma.withdrawal.findUnique as jest.Mock).mockResolvedValue(withdrawal);

    await expect(retryWithdrawal(WITHDRAWAL_ID, SUPER_ADMIN_ID, 'SUPER_ADMIN')).rejects.toMatchObject({
      message: 'This withdrawal is not eligible for retry',
      extensions: { code: 'INVALID_STATUS' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paystack.initiateTransfer).not.toHaveBeenCalled();
  });
});

describe('handleTransferFailed', () => {
  const failing = (withdrawal: Withdrawal) => {
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(withdrawal);
    tx.withdrawal.findUnique.mockResolvedValue(withdrawal);
  };

  it('returns the debit of a withdrawal still processing on that reference', async () => {
    failing(processingAttempt(0));

    await handleTransferFailed({ reference: attemptReference(0) }, 'Could not resolve account');

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: 0 },
      data: expect.objectContaining({ status: 'PENDING', retryCount: 1, failureReason: 'Could not resolve account' }),
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({
        type: 'CREDIT',
        source: 'WITHDRAWAL_REVERSAL',
        amount: 500_000,
        reference: `WDR_REV_${WITHDRAWAL_ID}_0`,
      }),
    ]);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('credits nothing for a repeat event once the withdrawal is back to pending', async () => {
    failing(
      makeWithdrawal({
        retryCount: 1,
        transferReference: attemptReference(0),
        failureReason: 'Could not resolve account',
        lastRetryAt: new Date(),
      })
    );

    await handleTransferFailed({ reference: attemptReference(0) }, 'Could not resolve account');

    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('fails the withdrawal, unlocks the wallet and tells the provider when the last attempt fails', async () => {
    failing(processingAttempt(4, { scheduledPayoutId: SCHEDULED_PAYOUT_ID }));
    (prisma.scheduledPayout.update as jest.Mock).mockResolvedValue({});

    await handleTransferFailed({ reference: attemptReference(4) }, 'Could not resolve account');

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: 4 },
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: expect.stringContaining('Failed after 5 attempts'),
      }),
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ type: 'CREDIT', amount: 500_000, reference: `WDR_REV_${WITHDRAWAL_ID}_4` }),
    ]);
    expect(tx.wallet.update).toHaveBeenLastCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: false, lockedReason: null },
    });
    expect(prisma.scheduledPayout.update).toHaveBeenCalledWith({
      where: { id: SCHEDULED_PAYOUT_ID },
      data: { status: 'FAILED', processedAt: expect.any(Date), failureReason: 'Could not resolve account' },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: 'PAYMENT_FAILED', title: 'Withdrawal Failed' })
    );
    expect(sendPushToUser).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ title: 'Withdrawal Failed' }));
  });
});

describe('handleTransferSuccess', () => {
  const event = { reference: attemptReference(0), transferCode: 'TRF_1' };

  it('completes a processing withdrawal, unlocks the wallet and tells the provider', async () => {
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(processingAttempt(0));

    await handleTransferSuccess(event);

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date), transferCode: 'TRF_1' },
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: false, lockedReason: null },
    });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: 'PAYMENT_RECEIVED' })
    );
  });

  it('changes nothing and sends no notification for a repeat event', async () => {
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(
      processingAttempt(0, { status: 'COMPLETED', transferCode: 'TRF_1', completedAt: new Date() })
    );
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });

    await handleTransferSuccess(event);

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  describe('for a withdrawal whose amount was already returned to the wallet', () => {
    const reversalOf = (attempt: number) => ({
      id: '66e2b4c1f0a9d83b5c7e1a30',
      walletId: WALLET_ID,
      type: 'CREDIT',
      source: 'WITHDRAWAL_REVERSAL',
      amount: 500_000,
      reference: `WDR_REV_${WITHDRAWAL_ID}_${attempt}`,
      withdrawalId: WITHDRAWAL_ID,
    });

    // Conditional updates match only the stored status, and reference lookups
    // find only the given ledger entries
    const stored = (withdrawal: Withdrawal, ledger: { reference: string }[]) => {
      (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(withdrawal);
      tx.withdrawal.findUnique.mockResolvedValue(withdrawal);
      tx.withdrawal.updateMany.mockImplementation(async ({ where }: { where: { status: string } }) => ({
        count: where.status === withdrawal.status ? 1 : 0,
      }));
      tx.walletTransaction.findUnique.mockImplementation(
        async ({ where }: { where: { reference: string } }) =>
          ledger.find((entry) => entry.reference === where.reference) ?? null
      );
    };

    // Attempt 1 failed and was refunded; the withdrawal waits for review
    const awaitingReview = () =>
      makeWithdrawal({
        retryCount: 2,
        transferReference: attemptReference(1),
        processedAt: new Date(),
        processedBy: ADMIN_ID,
        failureReason: 'Could not resolve account',
      });

    const lateEvent = (attempt: number) => ({ reference: attemptReference(attempt), transferCode: 'TRF_LATE' });

    it('completes it, takes the refund back and unlocks the wallet in one transaction', async () => {
      stored(awaitingReview(), [reversalOf(1)]);

      await handleTransferSuccess(lateEvent(1));

      expect(tx.withdrawal.updateMany).toHaveBeenLastCalledWith({
        where: { id: WITHDRAWAL_ID, status: 'PENDING', transferReference: attemptReference(1) },
        data: { status: 'COMPLETED', completedAt: expect.any(Date), failureReason: null },
      });
      // No isLocked condition: the wallet is still locked for review
      expect(tx.wallet.updateMany).toHaveBeenCalledWith({
        where: { id: WALLET_ID, balance: { gte: 500_000 } },
        data: { balance: { decrement: 500_000 } },
      });
      expect(ledgerEntries()).toEqual([
        expect.objectContaining({
          type: 'DEBIT',
          source: 'WITHDRAWAL',
          amount: 500_000,
          reference: `WDR_LATE_${WITHDRAWAL_ID}_1`,
          withdrawalId: WITHDRAWAL_ID,
        }),
      ]);
      expect(tx.wallet.update).toHaveBeenCalledWith({
        where: { id: WALLET_ID },
        data: { isLocked: false, lockedReason: null },
      });
      // The first transaction only tried completing a PROCESSING withdrawal
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, type: 'PAYMENT_RECEIVED', title: 'Withdrawal Successful' })
      );
      expect(createBulkNotifications).not.toHaveBeenCalled();
    });

    it.each([
      ['FAILED', makeWithdrawal({ status: 'FAILED', retryCount: 4, transferReference: attemptReference(4) }), 4],
      ['CANCELLED', makeWithdrawal({ status: 'CANCELLED', retryCount: 2, transferReference: attemptReference(1) }), 1],
    ])('takes the refund back from a %s withdrawal without touching the wallet lock', async (status, withdrawal, attempt) => {
      stored(withdrawal, [reversalOf(attempt)]);

      await handleTransferSuccess(lateEvent(attempt));

      expect(tx.withdrawal.updateMany).toHaveBeenLastCalledWith({
        where: { id: WITHDRAWAL_ID, status, transferReference: attemptReference(attempt) },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      });
      expect(ledgerEntries()).toEqual([
        expect.objectContaining({ type: 'DEBIT', amount: 500_000, reference: `WDR_LATE_${WITHDRAWAL_ID}_${attempt}` }),
      ]);
      // It no longer holds the lock; a newer withdrawal may
      expect(tx.wallet.update).not.toHaveBeenCalled();
    });

    it('takes nothing back when no refund was made for that attempt', async () => {
      stored(awaitingReview(), []);

      await handleTransferSuccess(lateEvent(1));

      expect(tx.withdrawal.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('does nothing when that late payout was recorded already', async () => {
      stored(makeWithdrawal({ status: 'FAILED', retryCount: 4, transferReference: attemptReference(4) }), [
        reversalOf(4),
        { reference: `WDR_LATE_${WITHDRAWAL_ID}_4` },
      ]);

      await handleTransferSuccess(lateEvent(4));

      expect(tx.withdrawal.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it("changes nothing and alerts admins when the refund can't be taken back", async () => {
      stored(awaitingReview(), [reversalOf(1)]);
      // The provider has already spent the refund
      tx.wallet.updateMany.mockResolvedValue({ count: 0 });
      tx.wallet.findUnique.mockResolvedValue(makeWallet(20_000, true));

      await handleTransferSuccess(lateEvent(1));

      // The debit throws in the same transaction as the COMPLETED update, so both roll back
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }) }),
        expect.anything()
      );
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
        select: { id: true },
      });
      expect(createBulkNotifications).toHaveBeenCalledWith(
        [ADMIN_ID, SUPER_ADMIN_ID],
        'SYSTEM_ANNOUNCEMENT',
        'Withdrawal paid after a refund',
        expect.stringContaining(WITHDRAWAL_ID),
        'withdrawal',
        undefined,
        { withdrawalId: WITHDRAWAL_ID, reference: attemptReference(1) }
      );
    });

    it.each([
      [
        'was retried under a new attempt',
        () => tx.withdrawal.findUnique.mockResolvedValue(
          makeWithdrawal({ status: 'PROCESSING', retryCount: 2, transferReference: attemptReference(2) })
        ),
      ],
      [
        'changed before it could be completed',
        () => tx.withdrawal.updateMany.mockResolvedValue({ count: 0 }),
      ],
    ])('alerts admins and changes nothing when the withdrawal %s meanwhile', async (_label, changeMeanwhile) => {
      stored(awaitingReview(), [reversalOf(1)]);
      changeMeanwhile();

      await handleTransferSuccess(lateEvent(1));

      // Both attempts may pay out, so a person has to check
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(createBulkNotifications).toHaveBeenCalledWith(
        [ADMIN_ID, SUPER_ADMIN_ID],
        'SYSTEM_ANNOUNCEMENT',
        'Earlier withdrawal attempt was paid',
        expect.stringContaining(attemptReference(1)),
        'withdrawal',
        undefined,
        { withdrawalId: WITHDRAWAL_ID, reference: attemptReference(1) }
      );
    });
  });

  describe('for a reference that matches no withdrawal', () => {
    beforeEach(() => {
      (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(null);
      // The withdrawal has moved on to attempt 1
      (prisma.withdrawal.findUnique as jest.Mock).mockResolvedValue(processingAttempt(1));
    });

    it('alerts admins when an earlier attempt of one of our withdrawals was paid', async () => {
      await handleTransferSuccess({ reference: attemptReference(0), transferCode: 'TRF_OLD' });

      expect(prisma.withdrawal.findUnique).toHaveBeenCalledWith({ where: { id: WITHDRAWAL_ID } });
      expect(createBulkNotifications).toHaveBeenCalledWith(
        [ADMIN_ID, SUPER_ADMIN_ID],
        'SYSTEM_ANNOUNCEMENT',
        'Earlier withdrawal attempt was paid',
        expect.stringContaining(attemptReference(0)),
        'withdrawal',
        undefined,
        { withdrawalId: WITHDRAWAL_ID, reference: attemptReference(0) }
      );
      expect(captureException).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('only logs a reference that is not one of ours', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      await handleTransferSuccess({ reference: 'EK-LZ3K9A-8F2A1B3C', transferCode: 'TRF_OTHER' });

      expect(log).toHaveBeenCalledWith('Transfer not found: EK-LZ3K9A-8F2A1B3C');
      expect(createBulkNotifications).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    });
  });
});

describe('handleTransferReversed', () => {
  it('fails a completed withdrawal and returns the amount to the wallet under its own reference', async () => {
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(
      processingAttempt(2, { status: 'COMPLETED', transferCode: 'TRF_1', completedAt: new Date() })
    );

    await handleTransferReversed({ reference: attemptReference(2), transferCode: 'TRF_1' });

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'COMPLETED' },
      data: { status: 'FAILED', failureReason: 'The bank returned the transfer' },
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { balance: { increment: 500_000 } },
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({
        type: 'CREDIT',
        source: 'WITHDRAWAL_REVERSAL',
        amount: 500_000,
        reference: `WDR_RET_${WITHDRAWAL_ID}_2`,
      }),
    ]);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, title: 'Withdrawal Returned' })
    );
  });

  it('treats a reversal before completion as a failed attempt', async () => {
    const withdrawal = processingAttempt(0, { transferCode: 'TRF_1' });
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(withdrawal);
    tx.withdrawal.findUnique.mockResolvedValue(withdrawal);

    await handleTransferReversed({ reference: attemptReference(0), transferCode: 'TRF_1' });

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: 0 },
      data: expect.objectContaining({ status: 'PENDING', retryCount: 1, failureReason: 'Transfer reversed' }),
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ type: 'CREDIT', reference: `WDR_REV_${WITHDRAWAL_ID}_0` }),
    ]);
    expect(tx.wallet.update).toHaveBeenLastCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: true, lockedReason: 'Transfer failed - pending review' },
    });
  });
});

describe('the 5th attempt refunded, paid late, then returned by the bank', () => {
  // A small in-memory store: the withdrawal, the wallet balance and the ledger,
  // changed only through the conditional updates the service makes
  let stored: Withdrawal;
  let balance: number;
  let locked: boolean;
  const ledger = new Map<string, Record<string, unknown>>();

  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => stored[key as keyof Withdrawal] === value);

  beforeEach(() => {
    const LAST = 4;
    stored = processingAttempt(LAST, { transferCode: 'TRF_4' });
    // Attempt 4 debited ₦5,000 from ₦6,000
    balance = 100_000;
    locked = true;
    ledger.clear();
    ledger.set(`WDR_TXN_${WITHDRAWAL_ID}_${LAST}`, { type: 'DEBIT', amount: 500_000, walletId: WALLET_ID });

    (prisma.withdrawal.findFirst as jest.Mock).mockImplementation(async () => ({ ...stored }));
    tx.withdrawal.findUnique.mockImplementation(async () => ({ ...stored }));
    tx.withdrawal.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<Withdrawal> }) => {
        if (!matches(where)) return { count: 0 };
        stored = { ...stored, ...data };
        return { count: 1 };
      }
    );
    tx.walletTransaction.findUnique.mockImplementation(
      async ({ where }: { where: { reference: string } }) => ledger.get(where.reference) ?? null
    );
    tx.walletTransaction.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      ledger.set(data.reference as string, data);
      return data;
    });
    tx.wallet.update.mockImplementation(
      async ({ data }: { data: { balance?: { increment: number }; isLocked?: boolean } }) => {
        if (data.balance) balance += data.balance.increment;
        if (data.isLocked !== undefined) locked = data.isLocked;
        return makeWallet(balance, locked);
      }
    );
    tx.wallet.updateMany.mockImplementation(
      async ({ where, data }: { where: { balance: { gte: number } }; data: { balance: { decrement: number } } }) => {
        if (balance < where.balance.gte) return { count: 0 };
        balance -= data.balance.decrement;
        return { count: 1 };
      }
    );
    tx.wallet.findUnique.mockImplementation(async () => makeWallet(balance, locked));
  });

  it('credits the bank’s return, and ignores the events repeated afterwards', async () => {
    const event = { reference: attemptReference(4), transferCode: 'TRF_4' };

    // 1. The 5th attempt fails: the withdrawal fails for good and is refunded
    await handleTransferFailed(event, 'Transfer failed');
    expect(stored.status).toBe('FAILED');
    expect(balance).toBe(600_000);

    // 2. Paystack then reports it paid: the refund is taken back
    await handleTransferSuccess(event);
    expect(stored.status).toBe('COMPLETED');
    expect(balance).toBe(100_000);

    // 3. The bank returns the money: it goes back to the wallet
    await handleTransferReversed(event);
    expect(stored).toMatchObject({ status: 'FAILED', failureReason: 'The bank returned the transfer' });
    expect(balance).toBe(600_000);
    expect(ledger.get(`WDR_RET_${WITHDRAWAL_ID}_4`)).toMatchObject({
      type: 'CREDIT',
      source: 'WITHDRAWAL_REVERSAL',
      amount: 500_000,
    });
    expect(createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: USER_ID, title: 'Withdrawal Returned' })
    );

    // 4. Paystack repeats its success and reversal events
    const entries = ledger.size;
    await handleTransferSuccess(event);
    await handleTransferReversed(event);
    expect(stored.status).toBe('FAILED');
    expect(balance).toBe(600_000);
    expect(ledger.size).toBe(entries);
  });
});

describe('requestWithdrawal', () => {
  beforeEach(() => {
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(makeWallet(200_000_000, false));
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({
      id: 'bank1',
      providerId: PROVIDER_ID,
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      accountNumber: '0123456789',
      accountName: 'ADA OBI',
    });
    tx.withdrawal.create.mockImplementation(async ({ data }: { data: Partial<Withdrawal> }) => makeWithdrawal(data));
  });

  it.each([
    ['restricted', { restrictedAt: new Date(), restrictedUntil: null }],
    ['banned', { bannedAt: new Date(), bannedUntil: new Date(Date.now() + DAY_MS) }],
  ])('refuses a %s account without locking the wallet', async (_label, flags) => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...activeAccount, ...flags });

    await expect(
      requestWithdrawal(PROVIDER_ID, USER_ID, { amount: 5_000, bankAccountId: 'bank1' })
    ).rejects.toMatchObject({ extensions: { code: 'ACCOUNT_RESTRICTED' } });

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('refuses more than ₦1,000,000 in one withdrawal without locking the wallet', async () => {
    await expect(
      requestWithdrawal(PROVIDER_ID, USER_ID, { amount: 1_000_001, bankAccountId: 'bank1' })
    ).rejects.toMatchObject({ extensions: { code: 'WITHDRAWAL_LIMIT_EXCEEDED' } });

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('reports the remaining daily limit in naira', async () => {
    // ₦4,996,000 withdrawn today and ₦1,000 returned leaves ₦5,000
    (prisma.walletTransaction.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: 499_600_000 } })
      .mockResolvedValueOnce({ _sum: { amount: 100_000 } });

    await expect(
      requestWithdrawal(PROVIDER_ID, USER_ID, { amount: 5_000.5, bankAccountId: 'bank1' })
    ).rejects.toMatchObject({ extensions: { code: 'DAILY_LIMIT_EXCEEDED', remainingLimit: 5_000 } });

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the minimum withdrawal above the fee, so the smallest one still sends money', async () => {
    expect(MIN_WITHDRAWAL_NAIRA * 100).toBeGreaterThan(TRANSFER_FEE_KOBO);

    const withdrawal = await requestWithdrawal(PROVIDER_ID, USER_ID, { amount: MIN_WITHDRAWAL_NAIRA, bankAccountId: 'bank1' });

    expect(tx.withdrawal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 100_000, fee: 5_000, netAmount: 95_000, status: 'PENDING' }),
    });
    expect(withdrawal).toMatchObject({ amount: 1_000, netAmount: 950 });
  });

  it('alerts admins in-app once the request is saved', async () => {
    await requestWithdrawal(PROVIDER_ID, USER_ID, { amount: 25_000, bankAccountId: 'bank1' });

    expect(createBulkNotifications).toHaveBeenCalledWith(
      [ADMIN_ID, SUPER_ADMIN_ID],
      'SYSTEM_ANNOUNCEMENT',
      'New withdrawal request',
      'A withdrawal of ₦25,000 to ADA OBI (Guaranty Trust Bank) is waiting for approval.',
      'withdrawal',
      undefined,
      { withdrawalId: WITHDRAWAL_ID }
    );
    expect(tx.withdrawal.create.mock.invocationCallOrder[0]).toBeLessThan(
      (createBulkNotifications as jest.Mock).mock.invocationCallOrder[0]
    );
    // An expected event, not an error report
    expect(captureException).not.toHaveBeenCalled();
  });

  it('says when the request comes from a payout schedule, and still succeeds if alerting fails', async () => {
    (createBulkNotifications as jest.Mock).mockRejectedValue(new Error('Database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      requestWithdrawal(
        PROVIDER_ID,
        USER_ID,
        { amount: 7_500, bankAccountId: 'bank1' },
        { scheduledPayoutId: SCHEDULED_PAYOUT_ID }
      )
    ).resolves.toMatchObject({ status: 'PENDING' });

    expect((createBulkNotifications as jest.Mock).mock.calls[0][3]).toBe(
      'A scheduled payout of ₦7,500 to ADA OBI (Guaranty Trust Bank) is waiting for approval.'
    );
  });
});

describe('reconcileProcessingWithdrawals', () => {
  const longAgo = () => new Date(Date.now() - 45 * 60 * 1000);

  it('completes a transfer Paystack reports as successful', async () => {
    const stuck = processingAttempt(0, { transferCode: 'TRF_1', processedAt: longAgo() });
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([stuck]);
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(stuck);
    (paystack.fetchTransfer as jest.Mock).mockResolvedValue(transferResponse('success', 'TRF_1', attemptReference(0)));

    await expect(reconcileProcessingWithdrawals()).resolves.toEqual({ checked: 1, settled: 1 });

    expect(paystack.fetchTransfer).toHaveBeenCalledWith('TRF_1');
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { id: WALLET_ID },
      data: { isLocked: false, lockedReason: null },
    });
  });

  it('reverses an attempt Paystack has no record of', async () => {
    const stuck = processingAttempt(0, { processedAt: longAgo() });
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([stuck]);
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(stuck);
    tx.withdrawal.findUnique.mockResolvedValue(stuck);
    (paystack.verifyTransfer as jest.Mock).mockRejectedValue(notFound());

    await expect(reconcileProcessingWithdrawals()).resolves.toEqual({ checked: 1, settled: 1 });

    expect(paystack.verifyTransfer).toHaveBeenCalledWith(attemptReference(0));
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: WITHDRAWAL_ID, status: 'PROCESSING', retryCount: 0 },
      data: expect.objectContaining({ status: 'PENDING', failureReason: 'Paystack has no record of this transfer' }),
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ type: 'CREDIT', reference: `WDR_REV_${WITHDRAWAL_ID}_0` }),
    ]);
  });

  it('leaves a legacy reference alone when Paystack has no record of it', async () => {
    const legacy = processingAttempt(0, { transferReference: 'WDR_1700000000_abcd1234', processedAt: longAgo() });
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([legacy]);
    // Found if looked up, so a reversal would go through were it attempted
    (prisma.withdrawal.findFirst as jest.Mock).mockResolvedValue(legacy);
    tx.withdrawal.findUnique.mockResolvedValue(legacy);
    (paystack.verifyTransfer as jest.Mock).mockRejectedValue(notFound());

    await expect(reconcileProcessingWithdrawals()).resolves.toEqual({ checked: 1, settled: 0 });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
  });
});

describe('getProviderWithdrawals', () => {
  it('returns withdrawals in the paginated shape the schema expects', async () => {
    (prisma.withdrawal.findMany as jest.Mock).mockResolvedValue([
      processingAttempt(0, { transferCode: 'TRF_1', transferReference: 'WDR_1' }),
    ]);
    (prisma.withdrawal.count as jest.Mock).mockResolvedValue(1);

    const result = await getProviderWithdrawals(PROVIDER_ID, {}, { page: 1, limit: 10 });

    expect(result).toMatchObject({ total: 1, page: 1, totalPages: 1, hasNextPage: false });
    expect(result.items[0]).toMatchObject({
      amount: 5000,
      providerId: PROVIDER_ID,
      transferRef: 'WDR_1',
      bankAccountSnapshot: {
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: '0123456789',
        accountName: 'ADA OBI',
      },
    });
  });
});
