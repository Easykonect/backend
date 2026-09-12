/**
 * Escrow timing
 *
 * After the customer confirms delivery the payment is held for
 * RELEASE_DELAY_HOURS, then released to the provider's wallet. If the customer
 * never confirms, it's released AUTO_RELEASE_DAYS after the provider marked the
 * job complete. A dispute can be opened until the payment is released.
 */
export const RELEASE_DELAY_HOURS = 24;
export const AUTO_RELEASE_DAYS = 7;

/**
 * Wallet ledger references, one per business event. A retried event finds the
 * entry it already wrote instead of moving money twice.
 */
export const LedgerReference = {
  walletPayment: (bookingId: string) => `WPAY_${bookingId}`,
  // A payment can be refunded in parts: each later refund is keyed by the kobo
  // already refunded before it, which only ever grows
  refund: (paymentId: string, previouslyRefundedKobo = 0) =>
    previouslyRefundedKobo > 0 ? `RFD_${paymentId}_${previouslyRefundedKobo}` : `RFD_${paymentId}`,
  unappliedCharge: (paystackReference: string) => `CHG_${paystackReference}`,
  earning: (paymentId: string) => `ERN_${paymentId}`,
  withdrawal: (withdrawalId: string, attempt: number) => `WDR_TXN_${withdrawalId}_${attempt}`,
  withdrawalReversal: (withdrawalId: string, attempt: number) => `WDR_REV_${withdrawalId}_${attempt}`,
  // Takes a reversal back when the transfer went through after all
  withdrawalLatePayout: (withdrawalId: string, attempt: number) => `WDR_LATE_${withdrawalId}_${attempt}`,
  // Credits a completed transfer the bank sent back. Distinct from the reversal
  // of a failed attempt, which the same attempt may already have had.
  withdrawalReturn: (withdrawalId: string, attempt: number) => `WDR_RET_${withdrawalId}_${attempt}`,
} as const;

/**
 * Scheduled payouts: the background job runs once a day at this hour, Lagos time
 */
export const SCHEDULED_PAYOUT_HOUR = 8;
export const PAYOUT_JOB_TIMEZONE = 'Africa/Lagos';
