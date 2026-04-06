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

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { koboToNaira } from './wallet.service';

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
 * Group payments by date for charts
 */
const groupPaymentsByDate = (
  payments: any[],
  period: PaymentPeriod
): { date: string; amount: number; count: number }[] => {
  const grouped: Record<string, { amount: number; count: number }> = {};

  payments.forEach((payment) => {
    let dateKey: string;
    const date = new Date(payment.paidAt || payment.createdAt);

    switch (period) {
      case 'DAILY':
        dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
        break;
      case 'WEEKLY':
        dateKey = date.toISOString().split('T')[0];
        break;
      case 'MONTHLY':
        dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
        break;
      default:
        dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!grouped[dateKey]) {
      grouped[dateKey] = { amount: 0, count: 0 };
    }

    grouped[dateKey].amount += payment.providerPayout || payment.amount || 0;
    grouped[dateKey].count += 1;
  });

  return Object.entries(grouped)
    .map(([date, data]) => ({
      date,
      amount: data.amount,
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

  // Get refunds in the same period
  const refunds = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      status: 'REFUNDED',
      ...(dateFilter.gte || dateFilter.lte ? { refundedAt: dateFilter } : {}),
    },
  });

  // Calculate totals
  const grossEarnings = payments.reduce((sum, p) => sum + p.providerPayout, 0);
  const totalRefunds = refunds.reduce((sum, p) => sum + (p.refundAmount || 0), 0);
  const netEarnings = grossEarnings - totalRefunds;

  // Get pending earnings (completed bookings not yet paid to wallet)
  const pendingPayments = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      status: 'COMPLETED',
      walletTransactionId: null,
    },
  });
  const pendingPayouts = pendingPayments.reduce((sum, p) => sum + p.providerPayout, 0);

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
      withdrawableBalance = (wallet as any).balance / 100; // Convert kobo to naira
    }
  }

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
    summary: {
      grossEarnings,
      totalRefunds,
      netEarnings,
      totalBookings: payments.length,
      averageBookingValue: payments.length > 0 ? grossEarnings / payments.length : 0,
      refundCount: refunds.length,
    },
    dailyBreakdown: groupPaymentsByDate(payments, period),
    serviceBreakdown: groupPaymentsByService(payments),
    pendingPayouts,
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

  // Get refunds
  const refundWhere: any = {
    status: 'REFUNDED',
    ...(dateFilter.gte || dateFilter.lte ? { refundedAt: dateFilter } : {}),
  };
  if (providerId) {
    refundWhere.booking = { providerId };
  }

  const refunds = await prisma.payment.findMany({
    where: refundWhere,
  });

  // Calculate totals
  const totalVolume = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalCommission = payments.reduce((sum, p) => sum + p.commission, 0);
  const totalPaystackFees = payments.reduce((sum, p) => sum + (p.paystackFee || 0), 0);
  const totalProviderPayouts = payments.reduce((sum, p) => sum + p.providerPayout, 0);
  const totalRefunds = refunds.reduce((sum, p) => sum + (p.refundAmount || 0), 0);
  const netRevenue = totalCommission - totalPaystackFees;

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

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
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
      refundRate: payments.length > 0 ? (refunds.length / payments.length) * 100 : 0,
    },
    dailyBreakdown: groupPaymentsByDate(payments, period).map((d) => ({
      ...d,
      commission: payments
        .filter((p) => {
          const date = new Date(p.paidAt || p.createdAt);
          const dateKey = date.toISOString().split('T')[0];
          return dateKey === d.date;
        })
        .reduce((sum, p) => sum + p.commission, 0),
    })),
    topProviders,
  };
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
      status: 'REFUNDED',
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

  return {
    period,
    startDate: dateFilter.gte?.toISOString() || null,
    endDate: dateFilter.lte?.toISOString() || null,
    summary: {
      totalRefunds,
      totalCount: refunds.length,
      fullRefundCount: fullRefunds.length,
      partialRefundCount: partialRefunds.length,
      averageRefundAmount: refunds.length > 0 ? totalRefunds / refunds.length : 0,
    },
    byReason: Object.entries(byReason).map(([reason, data]) => ({
      reason,
      count: data.count,
      amount: data.amount,
    })),
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

  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalCommission = payments.reduce((sum, p) => sum + p.commission, 0);
  const totalPaystackFees = payments.reduce((sum, p) => sum + (p.paystackFee || 0), 0);
  const totalProviderPayouts = payments.reduce((sum, p) => sum + p.providerPayout, 0);
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
