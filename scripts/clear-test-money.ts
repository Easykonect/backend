/**
 * Clear test money before switching Paystack from test keys to live keys
 *
 * Every naira in the wallets came from Paystack test cards. With live keys in
 * place that balance would be withdrawable as real money, so it has to go
 * first. This script:
 *   - sets every wallet balance (and pending balance) to zero and unlocks it
 *   - deletes every wallet ledger entry
 *   - deletes every withdrawal, including any still waiting to be processed
 *   - deletes every scheduled payout record
 *   - marks completed, paid bookings that were never released as released, so
 *     the automatic release job cannot credit test money back into a wallet
 *
 * Bookings, payments, accounts, services and bank accounts are left alone as
 * history. Reports only, unless run with --apply:
 *
 *   npx ts-node --transpile-only -O '{"module":"commonjs","moduleResolution":"node"}' \
 *     scripts/clear-test-money.ts [--apply]
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString()}`;

const main = async () => {
  const prisma = new PrismaClient();
  try {
    if ((process.env.PAYSTACK_SECRET_KEY ?? '').startsWith('sk_live')) {
      throw new Error(
        'Paystack is already on live keys. Clearing balances now could erase real money: stop and check by hand.'
      );
    }

    const wallets = await prisma.wallet.aggregate({
      _count: true,
      _sum: { balance: true, pendingBalance: true },
    });
    const ledgerEntries = await prisma.walletTransaction.count();
    const withdrawals = await prisma.withdrawal.count();
    const withdrawalsOpen = await prisma.withdrawal.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    });
    const scheduledPayouts = await prisma.scheduledPayout.count();

    // Completed, paid bookings that would pay out again once wallets are empty
    const unreleased = await prisma.booking.findMany({
      where: {
        status: 'COMPLETED',
        OR: [{ paymentReleasedAt: null }, { paymentReleasedAt: { isSet: false } }],
        payment: { is: { status: 'COMPLETED' } },
      },
      select: { id: true },
    });

    console.log(
      [
        `wallets:            ${wallets._count} holding ${naira(wallets._sum.balance ?? 0)} withdrawable, ${naira(wallets._sum.pendingBalance ?? 0)} pending`,
        `ledger entries:     ${ledgerEntries}`,
        `withdrawals:        ${withdrawals} (${withdrawalsOpen} still open)`,
        `scheduled payouts:  ${scheduledPayouts}`,
        `bookings that would pay out again: ${unreleased.length}`,
        'kept as history: bookings, payments, accounts, services, bank accounts',
      ].join('\n')
    );

    if (!apply) {
      console.log('\nReport only. Nothing changed. Run again with --apply to clear.');
      return;
    }

    const zeroed = await prisma.wallet.updateMany({
      data: { balance: 0, pendingBalance: 0, isLocked: false, lockedReason: null },
    });
    const ledgerDeleted = await prisma.walletTransaction.deleteMany({});
    const withdrawalsDeleted = await prisma.withdrawal.deleteMany({});
    const payoutsDeleted = await prisma.scheduledPayout.deleteMany({});
    const marked = unreleased.length
      ? await prisma.booking.updateMany({
          where: { id: { in: unreleased.map((booking) => booking.id) } },
          data: { paymentReleasedAt: new Date() },
        })
      : { count: 0 };

    const after = await prisma.wallet.aggregate({ _sum: { balance: true, pendingBalance: true } });

    console.log(
      [
        '',
        `wallets zeroed:            ${zeroed.count}`,
        `ledger entries deleted:    ${ledgerDeleted.count}`,
        `withdrawals deleted:       ${withdrawalsDeleted.count}`,
        `scheduled payouts deleted: ${payoutsDeleted.count}`,
        `bookings marked released:  ${marked.count}`,
        `wallet balance now:        ${naira(after._sum.balance ?? 0)} withdrawable, ${naira(after._sum.pendingBalance ?? 0)} pending`,
      ].join('\n')
    );
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
