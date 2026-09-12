/**
 * Payment Analytics Service
 * 
 * Provides detailed payment reports and analytics.
 * 
 * Features:
 * - Provider earnings reports (daily/weekly/monthly/all-time)
 * - Admin platform analytics
 * - Revenue breakdowns
 * - Refund statistics
 */

import prisma from '@/lib/prisma';

// ==========================================
// Types
// ==========================================

type PaymentPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ALL_TIME';

interface DateRange {
  startDate?: string;
  endDate?: string;
}

interface PaymentAnalyticsFilters extends DateRange {
  period: PaymentPeriod;
  providerId?: string;
}

// Payments with a refund: fully refunded, or partly refunded and still COMPLETED
const refundedPayments = {
  OR: [{ status: 'REFUNDED' as const }, { refundAmount: { gt: 0 } }],
};

/**
 * The amount refunded on a payment. Refunds recorded before refund amounts
 * were stored count as full refunds.
 */
const refundedAmount = (payment: { status: string; amount: number; refundAmount: number | null }) =>
  payment.refundAmount ?? (payment.status === 'REFUNDED' ? payment.amount : 0);

/**
 * What a payment kept after its refunds. On a payment's current split this is
 * commission + providerPayout.
 */
const keptAmount = (payment: { status: string; amount: number; refundAmount: number | null }) =>
  payment.amount - refundedAmount(payment);

// A money total to the kobo, without floating-point residue
const roundNaira = (naira: number) => Math.round(naira * 100) / 100;

const sumOf = <T>(items: T[], amountOf: (item: T) => number) =>
  roundNaira(items.reduce((sum, item) => sum + amountOf(item), 0));

/**
 * The key a payment date is grouped under: the day (YYYY-MM-DD) for daily and
 * weekly reports, the month (YYYY-MM) otherwise
 */
const periodKey = (date: Date, period: PaymentPeriod): string =>
  period === 'DAILY' || period === 'WEEKLY'
    ? date.toISOString().split('T')[0]
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

// ==========================================
// Helper Functions
// ==========================================

/**
 * Get date filter based on period
 */
const getDateFilter = (
  period: PaymentPeriod,
  startDate?: string,
  endDate?: string
): { gte?: Date; lte?: Date } => {
  const now = new Date();
  const filter: { gte?: Date; lte?: Date } = {};

  if (startDate) {
    filter.gte = new Date(startDate);
  } else {
    switch (period) {
      case 'DAILY':
        filter.gte = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'WEEKLY':
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        filter.gte = weekAgo;
        break;
      case 'MONTHLY':
        filter.gte = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'ALL_TIME':
        // No filter for all time
        break;
    }
  }

  if (endDate) {
    filter.lte = new Date(endDate);
  } else {
    filter.lte = now;
  }

  return filter;
};

/**
 * Group payments by date for charts, adding up `amountOf` each payment
 */
const groupPaymentsByDate = <T extends { paidAt: Date | null; createdAt: Date }>(
  payments: T[],
  period: PaymentPeriod,
  amountOf: (payment: T) => number
): { date: string; amount: number; count: number }[] => {
  const grouped: Record<string, { amount: number; count: number }> = {};

  payments.forEach((payment) => {
    const dateKey = periodKey(new Date(payment.paidAt || payment.createdAt), period);

    if (!grouped[dateKey]) {
      grouped[dateKey] = { amount: 0, count: 0 };
    }

    grouped[dateKey].amount += amountOf(payment);
    grouped[dateKey].count += 1;
  });

  return Object.entries(grouped)
    .map(([date, data]) => ({
      date,
      amount: roundNaira(data.amount),
      count: data.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * Group payments by service for breakdown
 */
const groupPaymentsByService = (
  payments: any[]
): { serviceId: string; serviceName: string; amount: number; count: number }[] => {
  const grouped: Record<string, { serviceName: string; amount: number; count: number }> = {};

  payments.forEach((payment) => {
    const serviceId = payment.booking?.serviceId || 'unknown';
    const serviceName = payment.booking?.service?.name || 'Unknown Service';

    if (!grouped[serviceId]) {
      grouped[serviceId] = { serviceName, amount: 0, count: 0 };
    }

    grouped[serviceId].amount += payment.providerPayout || 0;
    grouped[serviceId].count += 1;
  });

  return Object.entries(grouped)
    .map(([serviceId, data]) => ({
      serviceId,
      serviceName: data.serviceName,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount);
};

// ==========================================
// Provider Analytics
// ==========================================

/**
 * Get provider earnings report
 */
export const getProviderEarningsReport = async (
  providerId: string,
  period: PaymentPeriod,
  startDate?: string,
  endDate?: string
) => {
  const dateFilter = getDateFilter(period, startDate, endDate);

  // Get completed payments
  const payments = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      status: 'COMPLETED',
      ...(dateFilter.gte || dateFilter.lte ? { paidAt: dateFilter } : {}),
    },
    include: {
      booking: {
        include: {
          service: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { paidAt: 'desc' },
  });

  // Get refunds (full and partial) in the same period
  const refunds = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      ...refundedPayments,
      ...(dateFilter.gte || dateFilter.lte ? { refundedAt: dateFilter } : {}),
    },
  });

  // Totals over the payments paid in the period. Each payment's split already
  // reflects its refunds, so totalEarnings - commissionPaid - refunds on them
  // = netEarnings, the provider's share.
  const totalEarnings = sumOf(payments, (p) => p.amount);
  const commissionPaid = sumOf(payments, (p) => p.commission);
  const refundedOnPayments = sumOf(payments, refundedAmount);
  const netEarnings = sumOf(payments, (p) => p.providerPayout);
  // Refunds made in the period, on any payment
  const totalRefunds = sumOf(refunds, refundedAmount);

  // The provider's share of those payments not yet released to their wallet
  const pendingBalance = sumOf(
    payments.filter((p) => !p.payoutAt && !p.walletTransactionId),
    (p) => p.providerPayout
  );

  // Get withdrawable balance
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { userId: true },
  });

  let withdrawableBalance = 0;
  if (provider) {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: provider.userId },
    });
    if (wallet) {
      withdrawableBalance = wallet.balance / 100; // Convert kobo to naira
    }
  }

  const withdrawn = await prisma.withdrawal.aggregate({
    where: {
      providerId,
      status: 'COMPLETED',
      ...(dateFilter.gte || dateFilter.lte ? { completedAt: dateFilter } : {}),
    },
    _sum: { amount: true },
  });
  const dailyBreakdown = groupPaymentsByDate(payments, period, (p) => p.providerPayout);
  // Payments are newest first; ALL_TIME has no start filter
  const earliestPaidAt = payments[payments.length - 1]?.paidAt;
  const now = new Date();

  return {
    period,
    startDate: (dateFilter.gte ?? earliestPaidAt ?? now).toISOString(),
    endDate: (dateFilter.lte ?? now).toISOString(),
    totalEarnings,
    completedJobs: payments.length,
    commissionPaid,
    netEarnings,
    withdrawnAmount: (withdrawn._sum.amount ?? 0) / 100, // kobo to naira
    pendingBalance,
    breakdown: dailyBreakdown.map((d) => ({ date: d.date, earnings: d.amount, jobs: d.count })),
    summary: {
      grossEarnings: totalEarnings,
      commissionPaid,
      refundedOnPayments,
      totalRefunds,
      netEarnings,
      totalBookings: payments.length,
      averageBookingValue: payments.length > 0 ? roundNaira(totalEarnings / payments.length) : 0,
      refundCount: refunds.length,
    },
    dailyBreakdown,
    serviceBreakdown: groupPaymentsByService(payments),
    pendingPayouts: pendingBalance,
    withdrawableBalance,
    recentPayments: payments.slice(0, 10).map((p) => ({
      id: p.id,
      amount: p.providerPayout,
      serviceName: p.booking?.service?.name || 'Unknown',
      paidAt: p.paidAt?.toISOString() || null,
    })),
  };
};

// ==========================================
// Admin Analytics
// ==========================================

/**
 * Get platform-wide payment analytics (admin)
 */
export const getAdminPaymentAnalytics = async (
  filters: PaymentAnalyticsFilters
) => {
  const { period, providerId, startDate, endDate } = filters;
  const dateFilter = getDateFilter(period, startDate, endDate);

  const where: any = {
    status: 'COMPLETED',
    ...(dateFilter.gte || dateFilter.lte ? { paidAt: dateFilter } : {}),
  };

  if (providerId) {
    where.booking = { providerId };
  }

  // Get all completed payments
  const payments = await prisma.payment.findMany({
    where,
    include: {
      booking: {
        include: {
          provider: { select: { id: true, businessName: true } },
          service: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { paidAt: 'desc' },
  });

  // Get refunds (full and partial)
  const refundWhere: any = {
    ...refundedPayments,
    ...(dateFilter.gte || dateFilter.lte ? { refundedAt: dateFilter } : {}),
  };
  if (providerId) {
    refundWhere.booking = { providerId };
  }

  const refunds = await prisma.payment.findMany({
    where: refundWhere,
  });

  // Totals over the payments paid in the period, net of their refunds: volume
  // is what those payments kept, which is totalCommission + totalProviderPayouts
  const totalVolume = sumOf(payments, keptAmount);
  const totalCommission = sumOf(payments, (p) => p.commission);
  const totalPaystackFees = sumOf(payments, (p) => p.paystackFee || 0);
  const totalProviderPayouts = sumOf(payments, (p) => p.providerPayout);
  // Refunds made in the period, on any payment
  const totalRefunds = sumOf(refunds, refundedAmount);
  const netRevenue = roundNaira(totalCommission - totalPaystackFees);

  // Get top earning providers
  const providerEarnings: Record<string, { id: string; name: string; earnings: number; bookings: number }> = {};
  
  payments.forEach((p) => {
    const providerId = p.booking?.provider?.id;
    const providerName = p.booking?.provider?.businessName || 'Unknown';
    
    if (providerId) {
      if (!providerEarnings[providerId]) {
        providerEarnings[providerId] = { id: providerId, name: providerName, earnings: 0, bookings: 0 };
      }
      providerEarnings[providerId].earnings += p.providerPayout;
      providerEarnings[providerId].bookings += 1;
    }
  });

  const topProviders = Object.values(providerEarnings)
    .sort((a, b) => b.earnings - a.earnings)
    .slice(0, 10);

  // Payments that never completed, in the same window by creation date
  const createdWhere = {
    ...(dateFilter.gte || dateFilter.lte ? { createdAt: dateFilter } : {}),
    ...(providerId ? { booking: { providerId } } : {}),
  };
  // A partly refunded payment is still COMPLETED, so only full refunds count as
  // refunded, and the refund rate is taken over every settled payment
  const fullRefundCount = refunds.filter((p) => p.status === 'REFUNDED').length;
  const settledCount = fullRefundCount + payments.length;

  const [pendingCount, failedCount] = await Promise.all([
    prisma.payment.count({ where: { ...createdWhere, status: 'PENDING' } }),
    prisma.payment.count({ where: { ...createdWhere, status: 'FAILED' } }),
  ]);

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
    totalTransactions: payments.length,
    totalVolume,
    totalCommission,
    totalRefunds,
    netRevenue,
    averageTransactionValue: payments.length > 0 ? totalVolume / payments.length : 0,
    transactionsByStatus: {
      completed: payments.length,
      pending: pendingCount,
      failed: failedCount,
      refunded: fullRefundCount,
    },
    summary: {
      totalVolume,
      totalCommission,
      totalPaystackFees,
      totalProviderPayouts,
      totalRefunds,
      netRevenue,
      transactionCount: payments.length,
      averageTransactionValue: payments.length > 0 ? totalVolume / payments.length : 0,
      refundCount: refunds.length,
      refundRate: settledCount > 0 ? (refunds.length / settledCount) * 100 : 0,
    },
    dailyBreakdown: groupPaymentsByDate(payments, period, keptAmount).map((d) => ({
      ...d,
      commission: sumOf(
        // Same key as the breakdown row, so monthly rows get their commission too
        payments.filter((p) => periodKey(new Date(p.paidAt || p.createdAt), period) === d.date),
        (p) => p.commission
      ),
    })),
    topProviders,
  };
};

/**
 * Providers who had the most earnings released to their wallets in the period
 * (admin): the SERVICE_EARNING credits to each provider's wallet, highest
 * first. `completedJobs` counts the bookings whose earnings were released.
 */
export const getTopEarningProviders = async (limit: number = 10, period: PaymentPeriod = 'ALL_TIME') => {
  // The GraphQL request guard already caps limit; direct callers get the same rules
  const take = limit >= 1 ? Math.min(Math.trunc(limit), 100) : 10;
  const dateFilter = getDateFilter(period);

  const earnings = await prisma.walletTransaction.groupBy({
    by: ['walletId'],
    where: {
      type: 'CREDIT',
      source: 'SERVICE_EARNING',
      ...(dateFilter.gte || dateFilter.lte ? { createdAt: dateFilter } : {}),
    },
    _sum: { amount: true },
    _count: { _all: true },
    orderBy: [{ _sum: { amount: 'desc' } }, { walletId: 'asc' }],
    take,
  });

  if (earnings.length === 0) return [];

  const wallets = await prisma.wallet.findMany({
    where: { id: { in: earnings.map((row) => row.walletId) } },
    select: { id: true, userId: true },
  });
  const providers = await prisma.serviceProvider.findMany({
    where: { userId: { in: wallets.map((wallet) => wallet.userId) } },
    select: { id: true, userId: true, businessName: true },
  });

  const userByWallet = new Map(wallets.map((wallet) => [wallet.id, wallet.userId]));
  const providerByUser = new Map(providers.map((provider) => [provider.userId, provider]));

  // A wallet whose provider profile no longer exists is left out
  return earnings.flatMap((row) => {
    const provider = providerByUser.get(userByWallet.get(row.walletId) ?? '');
    if (!provider) return [];

    return [{
      providerId: provider.id,
      businessName: provider.businessName,
      totalEarnings: (row._sum.amount ?? 0) / 100, // kobo to naira
      completedJobs: row._count._all,
    }];
  });
};

/**
 * Get refund statistics (admin)
 */
export const getRefundStats = async (
  period: PaymentPeriod,
  startDate?: string,
  endDate?: string
) => {
  const dateFilter = getDateFilter(period, startDate, endDate);

  const refunds = await prisma.payment.findMany({
    where: {
      ...refundedPayments,
      ...(dateFilter.gte || dateFilter.lte ? { refundedAt: dateFilter } : {}),
    },
    include: {
      booking: {
        include: {
          provider: { select: { businessName: true } },
          service: { select: { name: true } },
          dispute: true,
        },
      },
    },
  });

  // Group by refund reason/via
  const byReason: Record<string, { count: number; amount: number }> = {};
  
  refunds.forEach((r) => {
    const reason = r.refundedVia || 'MANUAL';
    if (!byReason[reason]) {
      byReason[reason] = { count: 0, amount: 0 };
    }
    byReason[reason].count += 1;
    byReason[reason].amount += r.refundAmount || r.amount;
  });

  // Total amounts
  const totalRefunds = refunds.reduce((sum, r) => sum + (r.refundAmount || r.amount), 0);
  const fullRefunds = refunds.filter((r) => r.refundAmount === r.amount || !r.refundAmount);
  const partialRefunds = refunds.filter((r) => r.refundAmount && r.refundAmount < r.amount);

  const completedCount = await prisma.payment.count({
    where: {
      status: 'COMPLETED',
      ...(dateFilter.gte || dateFilter.lte ? { paidAt: dateFilter } : {}),
    },
  });
  const refundsByReason = Object.entries(byReason).map(([reason, data]) => ({
    reason,
    count: data.count,
    amount: data.amount,
  }));
  // Partially refunded payments are still COMPLETED, so already counted
  const settledCount = fullRefunds.length + completedCount;

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
    // Schema fields: totalRefunds is a count, totalRefundAmount the sum
    totalRefunds: refunds.length,
    totalRefundAmount: totalRefunds,
    refundRate: settledCount > 0 ? (refunds.length / settledCount) * 100 : 0,
    averageRefundAmount: refunds.length > 0 ? totalRefunds / refunds.length : 0,
    refundsByReason,
    summary: {
      totalRefunds,
      totalCount: refunds.length,
      fullRefundCount: fullRefunds.length,
      partialRefundCount: partialRefunds.length,
      averageRefundAmount: refunds.length > 0 ? totalRefunds / refunds.length : 0,
    },
    byReason: refundsByReason,
    recentRefunds: refunds.slice(0, 10).map((r) => ({
      id: r.id,
      amount: r.refundAmount || r.amount,
      originalAmount: r.amount,
      reason: r.refundReason,
      via: r.refundedVia,
      serviceName: r.booking?.service?.name || 'Unknown',
      providerName: r.booking?.provider?.businessName || 'Unknown',
      hasDispute: !!r.booking?.dispute,
      refundedAt: r.refundedAt?.toISOString() || null,
    })),
  };
};

/**
 * Get revenue breakdown (admin)
 */
export const getRevenueBreakdown = async (
  period: PaymentPeriod,
  startDate?: string,
  endDate?: string
) => {
  const dateFilter = getDateFilter(period, startDate, endDate);

  // Get payments and withdrawals
  const [payments, withdrawals] = await Promise.all([
    prisma.payment.findMany({
      where: {
        status: 'COMPLETED',
        ...(dateFilter.gte || dateFilter.lte ? { paidAt: dateFilter } : {}),
      },
    }),
    prisma.withdrawal.findMany({
      where: {
        status: 'COMPLETED',
        ...(dateFilter.gte || dateFilter.lte ? { completedAt: dateFilter } : {}),
      },
    }),
  ]);

  // Net of refunds, like the other payment totals
  const totalRevenue = sumOf(payments, keptAmount);
  const totalCommission = sumOf(payments, (p) => p.commission);
  const totalPaystackFees = sumOf(payments, (p) => p.paystackFee || 0);
  const totalProviderPayouts = sumOf(payments, (p) => p.providerPayout);
  const totalWithdrawals = withdrawals.reduce((sum, w) => sum + (w as any).amount, 0) / 100; // kobo to naira
  const totalWithdrawalFees = withdrawals.reduce((sum, w) => sum + (w as any).fee, 0) / 100;

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
    revenue: {
      totalTransactionVolume: totalRevenue,
      platformCommission: totalCommission,
      paystackFees: totalPaystackFees,
      netPlatformRevenue: totalCommission - totalPaystackFees,
    },
    payouts: {
      totalProviderEarnings: totalProviderPayouts,
      totalWithdrawals,
      withdrawalFees: totalWithdrawalFees,
      pendingInWallets: totalProviderPayouts - totalWithdrawals,
    },
    breakdown: {
      commissionRate: totalRevenue > 0 ? (totalCommission / totalRevenue) * 100 : 0,
      paystackFeeRate: totalRevenue > 0 ? (totalPaystackFees / totalRevenue) * 100 : 0,
      providerPayoutRate: totalRevenue > 0 ? (totalProviderPayouts / totalRevenue) * 100 : 0,
    },
  };
};

/**
 * Export payment report (admin)
 */
export const getPaymentReportData = async (
  filters: PaymentAnalyticsFilters
) => {
  const { period, providerId, startDate, endDate } = filters;
  const dateFilter = getDateFilter(period, startDate, endDate);

  const where: any = {
    ...(dateFilter.gte || dateFilter.lte ? { paidAt: dateFilter } : {}),
  };

  if (providerId) {
    where.booking = { providerId };
  }

  const payments = await prisma.payment.findMany({
    where,
    include: {
      booking: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          provider: { select: { businessName: true, user: { select: { email: true } } } },
          service: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return payments.map((p) => ({
    id: p.id,
    transactionRef: p.transactionRef,
    status: p.status,
    amount: p.amount,
    commission: p.commission,
    paystackFee: p.paystackFee || 0,
    providerPayout: p.providerPayout,
    paymentMethod: p.paymentMethod,
    customerName: p.booking?.user 
      ? `${p.booking.user.firstName} ${p.booking.user.lastName}` 
      : 'Unknown',
    customerEmail: p.booking?.user?.email || '',
    providerName: p.booking?.provider?.businessName || 'Unknown',
    providerEmail: p.booking?.provider?.user?.email || '',
    serviceName: p.booking?.service?.name || 'Unknown',
    paidAt: p.paidAt?.toISOString() || null,
    refundedAt: p.refundedAt?.toISOString() || null,
    refundAmount: p.refundAmount,
    createdAt: p.createdAt.toISOString(),
  }));
};
