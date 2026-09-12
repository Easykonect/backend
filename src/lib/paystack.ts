/**
 * Paystack Integration Library
 * 
 * Handles all Paystack API interactions for the Easykonnet platform.
 * 
 * API Documentation: https://paystack.com/docs/api/
 * 
 * Features:
 * - Initialize transactions
 * - Verify payments
 * - Process refunds
 * - Transfer to providers (payouts)
 * - Webhook signature verification
 * 
 * Commission: bookings use the rate a Super Admin sets (platform-settings.service);
 * the helpers here use the starting rate, COMMISSION_RATE
 */

import { config } from '@/config';
import crypto from 'crypto';

// ==========================================
// Types
// ==========================================

export interface PaystackInitializeParams {
  email: string;
  amount: number; // Amount in kobo (₦1 = 100 kobo)
  reference: string;
  callback_url?: string;
  metadata?: Record<string, any>;
  channels?: ('card' | 'bank' | 'ussd' | 'qr' | 'mobile_money' | 'bank_transfer')[];
}

export interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    domain: string;
    status: 'success' | 'failed' | 'abandoned' | 'pending';
    reference: string;
    amount: number;
    fees?: number | null; // Paystack's fee in kobo
    message: string | null;
    gateway_response: string;
    paid_at: string | null;
    created_at: string;
    channel: string;
    currency: string;
    ip_address: string;
    metadata: Record<string, any>;
    customer: {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string;
      phone: string | null;
    };
    authorization: {
      authorization_code: string;
      bin: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      channel: string;
      card_type: string;
      bank: string;
      country_code: string;
      brand: string;
      reusable: boolean;
    };
  };
}

export interface PaystackTransferRecipientParams {
  type: 'nuban' | 'mobile_money' | 'basa';
  name: string;
  account_number: string;
  bank_code: string;
  currency?: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface PaystackTransferRecipientResponse {
  status: boolean;
  message: string;
  data: {
    active: boolean;
    createdAt: string;
    currency: string;
    domain: string;
    id: number;
    integration: number;
    name: string;
    recipient_code: string;
    type: string;
    details: {
      authorization_code: string | null;
      account_number: string;
      account_name: string;
      bank_code: string;
      bank_name: string;
    };
  };
}

export interface PaystackTransferParams {
  source: string;
  amount: number; // Amount in kobo
  recipient: string; // recipient_code
  reason?: string;
  reference?: string;
}

export interface PaystackTransferResponse {
  status: boolean;
  message: string;
  data: {
    integration: number;
    domain: string;
    amount: number;
    currency: string;
    source: string;
    reason: string;
    recipient: number;
    status: 'pending' | 'success' | 'failed' | 'reversed' | 'otp' | 'abandoned' | 'blocked' | 'rejected' | 'received';
    reference?: string;
    transfer_code: string;
    id: number;
    createdAt: string;
    updatedAt: string;
  };
}

export interface PaystackRefundParams {
  transaction: string; // Transaction reference or ID
  amount?: number; // Amount to refund in kobo (optional, full refund if not provided)
  currency?: string;
  customer_note?: string;
  merchant_note?: string;
}

export interface PaystackRefundResponse {
  status: boolean;
  message: string;
  data: {
    transaction: {
      id: number;
      reference: string;
      amount: number;
    };
    integration: number;
    deducted_amount: number;
    channel: string | null;
    merchant_note: string;
    customer_note: string;
    status: 'pending' | 'processed' | 'failed';
    refunded_by: string;
    expected_at: string;
    currency: string;
    domain: string;
    amount: number;
    fully_deducted: boolean;
    id: number;
    createdAt: string;
  };
}

export interface PaystackBank {
  id: number;
  name: string;
  slug: string;
  code: string;
  longcode: string;
  gateway: string;
  active: boolean;
  country: string;
  currency: string;
  type: string;
}

export interface PaystackBankListResponse {
  status: boolean;
  message: string;
  data: PaystackBank[];
}

export interface PaystackResolveAccountResponse {
  status: boolean;
  message: string;
  data: {
    account_number: string;
    account_name: string;
    bank_id: number;
  };
}

export interface PaystackWebhookEvent {
  event: string;
  data: Record<string, any>;
}

// ==========================================
// Constants
// ==========================================

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// Paystack fee structure (as of 2025)
// Local transactions: 1.5% + ₦100 (capped at ₦2,000)
// International transactions: 3.9% + ₦100
export const PAYSTACK_LOCAL_FEE_PERCENT = 0.015; // 1.5%
export const PAYSTACK_LOCAL_FEE_FLAT = 100; // ₦100 in kobo = 10000 kobo, but waived for < ₦2,500
export const PAYSTACK_FEE_CAP = 200000; // ₦2,000 in kobo

// A Paystack call that hangs would otherwise hold the request open indefinitely
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A failed Paystack call. `httpStatus` is set when Paystack answered with an
 * error; it's undefined when the outcome is unknown (timeout, network error),
 * in which case the operation may still have gone through.
 */
export class PaystackRequestError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'PaystackRequestError';
  }
}

// ==========================================
// Helper Functions
// ==========================================

/**
 * Get Paystack secret key from config
 */
const getSecretKey = (): string => {
  const secretKey = config.payment.paystack.secretKey;
  if (!secretKey) {
    throw new Error('Paystack secret key not configured. Set PAYSTACK_SECRET_KEY in environment.');
  }
  return secretKey;
};

/**
 * Make authenticated request to Paystack API
 */
const paystackRequest = async <T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: Record<string, any>
): Promise<T> => {
  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const secretKey = getSecretKey();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };

  const options: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  let response: Response;
  let data: T & { message?: string };
  try {
    response = await fetch(url, options);
    // Node's fetch types `json()` as `unknown`; Paystack always returns an
    // object carrying a `message` on failure.
    data = (await response.json()) as T & { message?: string };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error';
    throw new PaystackRequestError(`Paystack request failed: ${reason}`);
  }

  if (!response.ok) {
    throw new PaystackRequestError(
      `Paystack request failed: ${data.message || `Paystack API error: ${response.status}`}`,
      response.status
    );
  }

  return data;
};

/**
 * Generate unique transaction reference
 * Format: EK-{timestamp}-{random}
 */
export const generateTransactionReference = (): string => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `EK-${timestamp}-${random}`;
};

/**
 * Convert Naira to Kobo
 */
export const nairaToKobo = (naira: number): number => {
  return Math.round(naira * 100);
};

/**
 * Convert Kobo to Naira
 */
export const koboToNaira = (kobo: number): number => {
  return kobo / 100;
};

/**
 * Calculate Paystack processing fee
 * Local transactions: 1.5% (capped at ₦2,000)
 * For transactions below ₦2,500, the flat fee is waived
 */
export const calculatePaystackFee = (amountInKobo: number): number => {
  const fee = Math.round(amountInKobo * PAYSTACK_LOCAL_FEE_PERCENT);
  
  // Add flat fee only for transactions >= ₦2,500 (250000 kobo)
  const flatFee = amountInKobo >= 250000 ? PAYSTACK_LOCAL_FEE_FLAT * 100 : 0;
  const totalFee = fee + flatFee;
  
  // Cap at ₦2,000
  return Math.min(totalFee, PAYSTACK_FEE_CAP);
};

/**
 * Calculate platform commission at the configured rate
 */
export const calculatePlatformCommission = (amountInKobo: number): number => {
  return Math.round(amountInKobo * config.platform.commissionRate);
};

/**
 * Calculate provider payout after commission and Paystack fees
 */
export const calculateProviderPayout = (serviceAmountInKobo: number): {
  serviceAmount: number;
  paystackFee: number;
  platformCommission: number;
  providerPayout: number;
} => {
  const paystackFee = calculatePaystackFee(serviceAmountInKobo);
  const platformCommission = calculatePlatformCommission(serviceAmountInKobo);
  const providerPayout = serviceAmountInKobo - platformCommission;
  
  return {
    serviceAmount: serviceAmountInKobo,
    paystackFee,
    platformCommission,
    providerPayout,
  };
};

/**
 * Verify Paystack webhook signature
 */
export const verifyWebhookSignature = (
  payload: string,
  signature: string
): boolean => {
  const secretKey = getSecretKey();
  const hash = crypto
    .createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex');
  
  return hash === signature;
};

// ==========================================
// Paystack API Functions
// ==========================================

/**
 * Initialize a transaction
 * Creates a payment link for the customer
 */
export const initializeTransaction = async (
  params: PaystackInitializeParams
): Promise<PaystackInitializeResponse> => {
  return paystackRequest<PaystackInitializeResponse>('/transaction/initialize', 'POST', {
    ...params,
    amount: params.amount, // Already in kobo
  });
};

/**
 * Verify a transaction
 * Confirms payment status
 */
export const verifyTransaction = async (
  reference: string
): Promise<PaystackVerifyResponse> => {
  return paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(reference)}`);
};

/**
 * Create a transfer recipient
 * Required before initiating transfers to providers
 */
export const createTransferRecipient = async (
  params: PaystackTransferRecipientParams
): Promise<PaystackTransferRecipientResponse> => {
  return paystackRequest<PaystackTransferRecipientResponse>('/transferrecipient', 'POST', {
    ...params,
    currency: params.currency || 'NGN',
  });
};

/**
 * Initiate a transfer to a provider
 * Sends money to provider's bank account
 */
export const initiateTransfer = async (
  params: PaystackTransferParams
): Promise<PaystackTransferResponse> => {
  return paystackRequest<PaystackTransferResponse>('/transfer', 'POST', {
    ...params,
    source: 'balance',
  });
};

/**
 * Look up a transfer by our reference. Throws PaystackRequestError with
 * httpStatus 404 when Paystack has no transfer with that reference.
 */
export const verifyTransfer = async (
  reference: string
): Promise<PaystackTransferResponse> => {
  return paystackRequest<PaystackTransferResponse>(`/transfer/verify/${encodeURIComponent(reference)}`);
};

/**
 * Fetch a transfer by its id or transfer code
 */
export const fetchTransfer = async (
  idOrCode: string
): Promise<PaystackTransferResponse> => {
  return paystackRequest<PaystackTransferResponse>(`/transfer/${encodeURIComponent(idOrCode)}`);
};

/**
 * Process a refund
 * Refunds a completed transaction
 */
export const processRefund = async (
  params: PaystackRefundParams
): Promise<PaystackRefundResponse> => {
  return paystackRequest<PaystackRefundResponse>('/refund', 'POST', params);
};

/**
 * List Nigerian banks
 * Get all supported banks for transfers
 */
export const listBanks = async (
  country: string = 'nigeria'
): Promise<PaystackBankListResponse> => {
  return paystackRequest<PaystackBankListResponse>(`/bank?country=${country}`);
};

/**
 * Resolve bank account
 * Verify account number and get account name
 */
export const resolveAccount = async (
  accountNumber: string,
  bankCode: string
): Promise<PaystackResolveAccountResponse> => {
  return paystackRequest<PaystackResolveAccountResponse>(
    `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
  );
};

/**
 * Get transaction details
 */
export const getTransaction = async (
  idOrReference: string | number
): Promise<PaystackVerifyResponse> => {
  return paystackRequest<PaystackVerifyResponse>(`/transaction/${encodeURIComponent(String(idOrReference))}`);
};

/**
 * Check Paystack balance
 */
export const checkBalance = async (): Promise<{
  status: boolean;
  data: { currency: string; balance: number }[];
}> => {
  return paystackRequest('/balance');
};

// ==========================================
// Export all functions
// ==========================================

export const paystack = {
  // Transaction
  initializeTransaction,
  verifyTransaction,
  getTransaction,
  
  // Transfers (Payouts)
  createTransferRecipient,
  initiateTransfer,
  verifyTransfer,
  fetchTransfer,

  // Refunds
  processRefund,
  
  // Banks
  listBanks,
  resolveAccount,
  
  // Balance
  checkBalance,
  
  // Utilities
  generateTransactionReference,
  nairaToKobo,
  koboToNaira,
  calculatePaystackFee,
  calculatePlatformCommission,
  calculateProviderPayout,
  verifyWebhookSignature,
};

export default paystack;
