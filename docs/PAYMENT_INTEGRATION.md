# Payment Integration Guide

Complete guide for integrating the Easykonnet payment system on the frontend for all user roles.

## Table of Contents

1. [Overview](#overview)
2. [Payment Flow](#payment-flow)
3. [User (Customer) Integration](#user-customer-integration)
4. [Service Provider Integration](#service-provider-integration)
5. [Admin Integration](#admin-integration)
6. [Super Admin Integration](#super-admin-integration)
7. [GraphQL Mutations & Queries](#graphql-mutations--queries)
8. [Webhook Handling](#webhook-handling)
9. [Error Handling](#error-handling)

---

## Overview

### Commission Structure
- **Platform Commission**: 7% of service fee
- **Paystack Fee**: 1.5% (capped at ₦2,000)
- **Provider Receives**: ~91.5-92% of service fee

### Payment States
| Status | Description |
|--------|-------------|
| `PENDING` | Payment initialized, awaiting customer action |
| `COMPLETED` | Payment successful, funds held in escrow |
| `FAILED` | Payment failed |
| `REFUNDED` | Full refund processed |
| `PARTIALLY_REFUNDED` | Partial refund processed |

### Booking States (Payment Related)
| Status | Description |
|--------|-------------|
| `PENDING` | Booking created, awaiting provider acceptance |
| `ACCEPTED` | Provider accepted, awaiting payment |
| `PAID` | Customer paid, service can begin |
| `IN_PROGRESS` | Service being delivered |
| `COMPLETED` | Service completed, awaiting customer confirmation |
| `CONFIRMED` | Customer confirmed delivery, 24hr dispute window started |

---

## Payment Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           COMPLETE PAYMENT FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

1. BOOKING & PAYMENT
   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Customer │───▶│ Provider │───▶│ Customer │───▶│ Paystack │
   │  Books   │    │ Accepts  │    │   Pays   │    │ Processes│
   └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                         │
2. SERVICE DELIVERY                                      ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Provider │───▶│ Provider │───▶│ Provider │───▶│  Funds   │
   │ Arrives  │    │ Delivers │    │ Completes│    │ in Escrow│
   └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                         │
3. CONFIRMATION & PAYOUT                                 ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Customer │───▶│ 24-Hour  │───▶│ Auto/    │───▶│ Provider │
   │ Confirms │    │ Dispute  │    │ Manual   │    │ Receives │
   │ Delivery │    │ Window   │    │ Release  │    │ Payout   │
   └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## User (Customer) Integration

### 1. View My Bookings

```graphql
query MyBookings($pagination: PaginationInput, $filters: BookingFiltersInput) {
  myBookings(pagination: $pagination, filters: $filters) {
    bookings {
      id
      status
      totalAmount
      scheduledDate
      scheduledTime
      customerConfirmedAt
      paymentReleaseAt
      payment {
        id
        status
        amount
        transactionRef
        paidAt
      }
      service {
        id
        name
        price
      }
      provider {
        id
        businessName
        user {
          firstName
          lastName
        }
      }
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

### 2. Initialize Payment (After Provider Accepts)

```graphql
mutation InitializePayment($input: InitializePaymentInput!) {
  initializePayment(input: $input) {
    success
    message
    authorizationUrl  # Redirect customer to this Paystack URL
    accessCode
    reference
  }
}
```

**Variables:**
```json
{
  "input": {
    "bookingId": "booking_id_here",
    "callbackUrl": "https://yourapp.com/payment/callback"
  }
}
```

**Frontend Implementation:**
```typescript
const handlePayment = async (bookingId: string) => {
  try {
    const { data } = await initializePayment({
      variables: {
        input: {
          bookingId,
          callbackUrl: `${window.location.origin}/payment/callback`
        }
      }
    });
    
    if (data.initializePayment.success) {
      // Redirect to Paystack checkout
      window.location.href = data.initializePayment.authorizationUrl;
    }
  } catch (error) {
    // Handle error
  }
};
```

### 3. Verify Payment (On Callback)

```graphql
mutation VerifyPayment($transactionRef: String!) {
  verifyPayment(transactionRef: $transactionRef) {
    id
    status
    amount
    transactionRef
    paidAt
    booking {
      id
      status
    }
  }
}
```

**Callback Page Implementation:**
```typescript
// pages/payment/callback.tsx
const PaymentCallback = () => {
  const router = useRouter();
  const { reference } = router.query;
  
  useEffect(() => {
    if (reference) {
      verifyPayment({ variables: { transactionRef: reference } })
        .then(({ data }) => {
          if (data.verifyPayment.status === 'COMPLETED') {
            router.push('/bookings?payment=success');
          } else {
            router.push('/bookings?payment=failed');
          }
        });
    }
  }, [reference]);
  
  return <LoadingSpinner message="Verifying payment..." />;
};
```

### 4. Pay with Wallet Balance

```graphql
mutation PayWithWallet($input: PayWithWalletInput!) {
  payWithWallet(input: $input) {
    id
    status
    amount
    booking {
      id
      status
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "bookingId": "booking_id_here"
  }
}
```

### 5. Get My Wallet

```graphql
query MyWallet {
  myWallet {
    id
    balance
    currency
    createdAt
    updatedAt
  }
}
```

### 6. Get Wallet Transactions

```graphql
query MyWalletTransactions(
  $pagination: PaginationInput
  $filters: WalletTransactionFiltersInput
) {
  myWalletTransactions(pagination: $pagination, filters: $filters) {
    transactions {
      id
      type
      amount
      balanceBefore
      balanceAfter
      description
      reference
      createdAt
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

### 7. Confirm Service Delivery (NEW - Triggers 24hr Dispute Window)

```graphql
mutation ConfirmServiceDelivery($bookingId: String!) {
  confirmServiceDelivery(bookingId: $bookingId) {
    id
    status
    customerConfirmedAt
    paymentReleaseAt  # 24 hours from confirmation
  }
}
```

**Frontend Implementation:**
```typescript
const handleConfirmDelivery = async (bookingId: string) => {
  const confirmed = await showConfirmDialog({
    title: 'Confirm Service Delivery',
    message: `Are you sure the service was delivered satisfactorily? 
              You have 24 hours after confirmation to raise a dispute 
              if there are any issues.`,
    confirmText: 'Yes, Confirm Delivery',
    cancelText: 'Not Yet'
  });
  
  if (confirmed) {
    try {
      await confirmServiceDelivery({ variables: { bookingId } });
      showToast('Service delivery confirmed! Provider will receive payment in 24 hours.');
    } catch (error) {
      showError(error.message);
    }
  }
};
```

### 8. Create Dispute (Within 24hr Window)

```graphql
mutation CreateDispute($input: CreateDisputeInput!) {
  createDispute(input: $input) {
    id
    status
    reason
    description
    createdAt
  }
}
```

**Variables:**
```json
{
  "input": {
    "bookingId": "booking_id_here",
    "reason": "SERVICE_NOT_AS_DESCRIBED",
    "description": "The service provided did not match what was agreed upon..."
  }
}
```

**Dispute Reasons:**
- `SERVICE_NOT_AS_DESCRIBED`
- `POOR_QUALITY`
- `INCOMPLETE_SERVICE`
- `PROVIDER_NO_SHOW`
- `OVERCHARGED`
- `OTHER`

### 9. Get My Payment History

```graphql
query MyPayments($pagination: PaginationInput) {
  myPayments(pagination: $pagination) {
    payments {
      id
      amount
      status
      transactionRef
      paidAt
      refundedAt
      booking {
        id
        service {
          name
        }
        provider {
          businessName
        }
      }
    }
    total
    page
    totalPages
  }
}
```

---

## Service Provider Integration

### 1. Get My Earnings

```graphql
query MyEarnings {
  myEarnings {
    totalEarnings
    thisMonthEarnings
    completedJobs
    commissionRate
  }
}
```

### 2. Get My Wallet (Provider Wallet)

```graphql
query MyWallet {
  myWallet {
    id
    balance        # Available for withdrawal
    currency
    createdAt
    updatedAt
  }
}
```

### 3. Get Wallet Transactions

```graphql
query MyWalletTransactions($pagination: PaginationInput) {
  myWalletTransactions(pagination: $pagination) {
    transactions {
      id
      type           # CREDIT (earnings), DEBIT (withdrawals)
      amount
      balanceBefore
      balanceAfter
      description
      reference
      createdAt
    }
    total
    page
    totalPages
  }
}
```

### 4. Setup Bank Account for Withdrawals

```graphql
# Step 1: Get list of banks
query Banks {
  banks {
    id
    name
    code
    country
  }
}

# Step 2: Verify bank account
query VerifyBankAccount($accountNumber: String!, $bankCode: String!) {
  verifyBankAccount(accountNumber: $accountNumber, bankCode: $bankCode) {
    accountNumber
    accountName
    bankId
  }
}

# Step 3: Add bank account
mutation AddBankAccount($input: AddBankAccountInput!) {
  addBankAccount(input: $input) {
    id
    bankName
    accountNumber
    accountName
    isDefault
  }
}
```

**Variables for Adding Bank Account:**
```json
{
  "input": {
    "bankCode": "058",
    "accountNumber": "0123456789",
    "accountName": "John Doe",
    "isDefault": true
  }
}
```

### 5. Request Withdrawal

```graphql
mutation RequestWithdrawal($input: RequestWithdrawalInput!) {
  requestWithdrawal(input: $input) {
    id
    amount
    status
    bankAccount {
      bankName
      accountNumber
    }
    createdAt
  }
}
```

**Variables:**
```json
{
  "input": {
    "amount": 50000,
    "bankAccountId": "bank_account_id_here"
  }
}
```

**Minimum Withdrawal:** ₦1,000

### 6. Get My Withdrawals

```graphql
query MyWithdrawals($pagination: PaginationInput) {
  myWithdrawals(pagination: $pagination) {
    withdrawals {
      id
      amount
      status       # PENDING, PROCESSING, COMPLETED, FAILED, REJECTED
      bankAccount {
        bankName
        accountNumber
        accountName
      }
      processedAt
      failureReason
      createdAt
    }
    total
    page
    totalPages
  }
}
```

### 7. Provider Dashboard - Earnings Widget

```typescript
const ProviderEarningsWidget = () => {
  const { data: earnings } = useQuery(MY_EARNINGS);
  const { data: wallet } = useQuery(MY_WALLET);
  
  return (
    <div className="earnings-widget">
      <div className="stat">
        <label>Available Balance</label>
        <value>₦{wallet?.myWallet.balance.toLocaleString()}</value>
      </div>
      <div className="stat">
        <label>Total Earnings</label>
        <value>₦{earnings?.myEarnings.totalEarnings.toLocaleString()}</value>
      </div>
      <div className="stat">
        <label>This Month</label>
        <value>₦{earnings?.myEarnings.thisMonthEarnings.toLocaleString()}</value>
      </div>
      <div className="stat">
        <label>Completed Jobs</label>
        <value>{earnings?.myEarnings.completedJobs}</value>
      </div>
      <div className="info">
        <small>Platform commission: {earnings?.myEarnings.commissionRate}%</small>
      </div>
    </div>
  );
};
```

---

## Admin Integration

> **Note:** Regular admins have **READ-ONLY** access to payment data. They cannot process refunds, withdrawals, or make wallet adjustments.

### 1. View Bookings (Can see payment status)

```graphql
query AllBookings($pagination: PaginationInput, $filters: BookingFiltersInput) {
  allBookings(pagination: $pagination, filters: $filters) {
    bookings {
      id
      status
      totalAmount
      customerConfirmedAt
      paymentReleaseAt
      payment {
        status
        amount
      }
      user {
        firstName
        lastName
        email
      }
      provider {
        businessName
      }
    }
    total
    page
    totalPages
  }
}
```

### 2. View Disputes

```graphql
query AllDisputes($pagination: PaginationInput, $filters: DisputeFiltersInput) {
  allDisputes(pagination: $pagination, filters: $filters) {
    disputes {
      id
      status
      reason
      description
      booking {
        id
        totalAmount
        payment {
          status
        }
      }
      user {
        firstName
        lastName
      }
      provider {
        businessName
      }
      createdAt
    }
    total
    page
    totalPages
  }
}
```

### Admin Permissions Summary

| Feature | Admin | Super Admin |
|---------|-------|-------------|
| View Bookings | ✅ | ✅ |
| View Disputes | ✅ | ✅ |
| Resolve Disputes | ✅ | ✅ |
| View Payments | ❌ | ✅ |
| Process Refunds | ❌ | ✅ |
| View Withdrawals | ❌ | ✅ |
| Process Withdrawals | ❌ | ✅ |
| View Payment Stats | ❌ | ✅ |
| Adjust Wallet Balance | ❌ | ✅ |

---

## Super Admin Integration

Super Admins have full access to all payment operations.

### 1. Payment Statistics Dashboard

```graphql
query PaymentStats {
  paymentStats {
    totalPayments
    completedPayments
    pendingPayments
    failedPayments
    refundedPayments
    totalRevenue          # Total money received
    totalCommission       # Platform earnings (7%)
    totalProviderPayouts  # Amount paid to providers
    commissionRate        # 7
  }
}
```

**Dashboard Implementation:**
```typescript
const SuperAdminPaymentDashboard = () => {
  const { data } = useQuery(PAYMENT_STATS);
  const stats = data?.paymentStats;
  
  return (
    <div className="payment-dashboard">
      <h2>Payment Overview</h2>
      
      {/* Revenue Cards */}
      <div className="revenue-cards">
        <Card title="Total Revenue" value={`₦${stats?.totalRevenue.toLocaleString()}`} />
        <Card 
          title="Platform Commission" 
          value={`₦${stats?.totalCommission.toLocaleString()}`}
          highlight
        />
        <Card title="Provider Payouts" value={`₦${stats?.totalProviderPayouts.toLocaleString()}`} />
      </div>
      
      {/* Payment Counts */}
      <div className="payment-counts">
        <Stat label="Total Payments" value={stats?.totalPayments} />
        <Stat label="Completed" value={stats?.completedPayments} color="green" />
        <Stat label="Pending" value={stats?.pendingPayments} color="yellow" />
        <Stat label="Failed" value={stats?.failedPayments} color="red" />
        <Stat label="Refunded" value={stats?.refundedPayments} color="gray" />
      </div>
      
      <p className="commission-info">
        Commission Rate: {stats?.commissionRate}%
      </p>
    </div>
  );
};
```

### 2. View All Payments

```graphql
query AllPayments(
  $pagination: PaginationInput
  $filters: PaymentFiltersInput
) {
  allPayments(pagination: $pagination, filters: $filters) {
    payments {
      id
      amount
      commission
      providerPayout
      paystackFee
      status
      transactionRef
      paymentMethod
      paidAt
      refundedAt
      booking {
        id
        service {
          name
        }
        user {
          firstName
          lastName
          email
        }
        provider {
          businessName
        }
      }
    }
    total
    page
    totalPages
    hasNextPage
  }
}
```

**Filter Variables:**
```json
{
  "filters": {
    "status": "COMPLETED",
    "startDate": "2026-01-01",
    "endDate": "2026-04-20"
  },
  "pagination": {
    "page": 1,
    "limit": 20
  }
}
```

### 3. Process Refund

```graphql
mutation ProcessRefund($input: RefundInput!) {
  processRefund(input: $input) {
    id
    status
    refundedAt
    booking {
      id
      status
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "paymentId": "payment_id_here",
    "amount": 5000,          # Optional: for partial refund (in Naira)
    "reason": "Customer requested refund due to service not delivered"
  }
}
```

**Full Refund (omit amount):**
```json
{
  "input": {
    "paymentId": "payment_id_here",
    "reason": "Provider cancelled before arrival"
  }
}
```

### 4. Refund Statistics

```graphql
query RefundStats($period: String) {
  refundStats(period: $period) {
    totalRefunds
    totalAmount
    averageRefundAmount
    refundsByReason {
      reason
      count
      amount
    }
  }
}
```

**Period Options:** `TODAY`, `THIS_WEEK`, `THIS_MONTH`, `THIS_YEAR`, `ALL_TIME`

### 5. View All Withdrawals

```graphql
query AllWithdrawals(
  $pagination: PaginationInput
  $filters: WithdrawalFiltersInput
) {
  allWithdrawals(pagination: $pagination, filters: $filters) {
    withdrawals {
      id
      amount
      status
      bankAccount {
        bankName
        accountNumber
        accountName
      }
      user {
        firstName
        lastName
        email
      }
      processedAt
      failureReason
      createdAt
    }
    total
    page
    totalPages
  }
}
```

### 6. Process Withdrawal (Approve)

```graphql
mutation ProcessWithdrawal($withdrawalId: String!) {
  processWithdrawal(withdrawalId: $withdrawalId) {
    id
    status
    processedAt
    transferCode
  }
}
```

### 7. Reject Withdrawal

```graphql
mutation RejectWithdrawal($withdrawalId: String!, $reason: String!) {
  rejectWithdrawal(withdrawalId: $withdrawalId, reason: $reason) {
    id
    status
    failureReason
  }
}
```

### 8. Retry Failed Withdrawal

```graphql
mutation RetryWithdrawal($withdrawalId: String!) {
  retryWithdrawal(withdrawalId: $withdrawalId) {
    id
    status
  }
}
```

### 9. Adjust User Wallet Balance

```graphql
mutation AdjustWalletBalance(
  $userId: String!
  $amount: Float!    # Positive = credit, Negative = debit
  $reason: String!
) {
  adjustWalletBalance(userId: $userId, amount: $amount, reason: $reason) {
    id
    balance
  }
}
```

**Credit Example:**
```json
{
  "userId": "user_id_here",
  "amount": 5000,
  "reason": "Compensation for service issue - Ticket #12345"
}
```

**Debit Example:**
```json
{
  "userId": "user_id_here",
  "amount": -2000,
  "reason": "Correction for duplicate credit"
}
```

**Limits:**
- Maximum adjustment: ₦1,000,000 per transaction

### 10. Withdrawal Management UI

```typescript
const WithdrawalManagement = () => {
  const { data, refetch } = useQuery(ALL_WITHDRAWALS, {
    variables: { filters: { status: 'PENDING' } }
  });
  
  const [processWithdrawal] = useMutation(PROCESS_WITHDRAWAL);
  const [rejectWithdrawal] = useMutation(REJECT_WITHDRAWAL);
  
  const handleApprove = async (withdrawalId: string) => {
    await processWithdrawal({ variables: { withdrawalId } });
    refetch();
    showToast('Withdrawal processed successfully');
  };
  
  const handleReject = async (withdrawalId: string, reason: string) => {
    await rejectWithdrawal({ variables: { withdrawalId, reason } });
    refetch();
    showToast('Withdrawal rejected');
  };
  
  return (
    <div>
      <h2>Pending Withdrawals</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Amount</th>
            <th>Bank</th>
            <th>Account</th>
            <th>Requested</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data?.allWithdrawals.withdrawals.map(w => (
            <tr key={w.id}>
              <td>{w.user.firstName} {w.user.lastName}</td>
              <td>₦{w.amount.toLocaleString()}</td>
              <td>{w.bankAccount.bankName}</td>
              <td>{w.bankAccount.accountNumber}</td>
              <td>{formatDate(w.createdAt)}</td>
              <td>
                <button onClick={() => handleApprove(w.id)}>Approve</button>
                <button onClick={() => openRejectModal(w.id)}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

---

## GraphQL Mutations & Queries Summary

### Customer Operations

| Operation | Type | Description |
|-----------|------|-------------|
| `initializePayment` | Mutation | Start Paystack payment |
| `verifyPayment` | Mutation | Verify payment after callback |
| `payWithWallet` | Mutation | Pay using wallet balance |
| `confirmServiceDelivery` | Mutation | Confirm service was delivered |
| `createDispute` | Mutation | Raise a dispute |
| `myBookings` | Query | Get customer's bookings |
| `myPayments` | Query | Get payment history |
| `myWallet` | Query | Get wallet balance |
| `myWalletTransactions` | Query | Get wallet history |

### Provider Operations

| Operation | Type | Description |
|-----------|------|-------------|
| `requestWithdrawal` | Mutation | Request payout |
| `addBankAccount` | Mutation | Add bank for withdrawals |
| `myEarnings` | Query | Get earnings summary |
| `myWallet` | Query | Get wallet balance |
| `myWalletTransactions` | Query | Get transaction history |
| `myWithdrawals` | Query | Get withdrawal history |
| `banks` | Query | List available banks |
| `verifyBankAccount` | Query | Verify bank account |

### Super Admin Operations

| Operation | Type | Description |
|-----------|------|-------------|
| `processRefund` | Mutation | Process customer refund |
| `processWithdrawal` | Mutation | Approve withdrawal |
| `rejectWithdrawal` | Mutation | Reject withdrawal |
| `retryWithdrawal` | Mutation | Retry failed withdrawal |
| `adjustWalletBalance` | Mutation | Manual wallet adjustment |
| `paymentStats` | Query | Platform payment statistics |
| `allPayments` | Query | All payments list |
| `refundStats` | Query | Refund statistics |
| `allWithdrawals` | Query | All withdrawals list |

---

## Webhook Handling

Paystack sends webhooks for payment events. The backend handles these automatically at `/api/webhooks/paystack`.

### Events Handled

| Event | Action |
|-------|--------|
| `charge.success` | Mark payment as completed, update booking status |
| `transfer.success` | Mark withdrawal as completed |
| `transfer.failed` | Mark withdrawal as failed, refund wallet |
| `refund.processed` | Update payment refund status |

### Frontend Webhook Awareness

For real-time updates, subscribe to these events via WebSocket:

```typescript
// Subscribe to booking/payment updates
socket.on('booking:updated', (booking) => {
  // Refresh booking data
  refetchBookings();
});

socket.on('payment:completed', (payment) => {
  showNotification('Payment received!');
  refetchPayments();
});

socket.on('withdrawal:processed', (withdrawal) => {
  showNotification(`Withdrawal of ₦${withdrawal.amount} processed!`);
  refetchWallet();
});
```

---

## Error Handling

### Common Payment Errors

| Error Code | Description | User Action |
|------------|-------------|-------------|
| `PAYMENT_NOT_FOUND` | Payment doesn't exist | Check booking ID |
| `INVALID_BOOKING_STATUS` | Booking not ready for payment | Wait for provider acceptance |
| `ALREADY_PAID` | Booking already paid | Refresh page |
| `INSUFFICIENT_BALANCE` | Not enough wallet balance | Top up or use card |
| `WITHDRAWAL_MINIMUM` | Below ₦1,000 minimum | Increase amount |
| `NO_BANK_ACCOUNT` | No bank account setup | Add bank account first |
| `DISPUTE_WINDOW_CLOSED` | 24hr window expired | Contact support |

### Error Handling Example

```typescript
const handlePaymentError = (error: ApolloError) => {
  const code = error.graphQLErrors[0]?.extensions?.code;
  
  switch (code) {
    case 'INVALID_BOOKING_STATUS':
      showError('Please wait for the provider to accept your booking before paying.');
      break;
    case 'ALREADY_PAID':
      showError('This booking has already been paid for.');
      refetchBooking();
      break;
    case 'INSUFFICIENT_BALANCE':
      showError('Insufficient wallet balance. Please use card payment.');
      break;
    case 'WITHDRAWAL_MINIMUM':
      showError('Minimum withdrawal amount is ₦1,000');
      break;
    default:
      showError('Something went wrong. Please try again.');
  }
};
```

---

## Testing

### Test Cards (Paystack Sandbox)

| Card Number | Type | Result |
|-------------|------|--------|
| `4084084084084081` | Visa | Success |
| `5060666666666666666` | Verve | Success |
| `4084080000000409` | Visa | Declined |

### Test Bank Account

- **Bank:** Test Bank
- **Account Number:** `0000000000`

---

## Security Notes

1. **Never store card details** - Paystack handles all card data
2. **Verify payments server-side** - Always verify with `verifyPayment` mutation
3. **Check booking ownership** - Backend validates user owns the booking
4. **24-hour dispute window** - Customers can dispute within 24 hours of confirmation
5. **Super Admin only** - Financial operations restricted to super admin role

---

## Support

For payment issues:
- Customers: Contact support through the app
- Providers: Contact support for withdrawal issues
- Technical: Check webhook logs in admin dashboard

