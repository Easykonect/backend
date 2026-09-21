/**
 * Messaging against a real MongoDB
 *
 * The unit tests mock Prisma, so a query MongoDB rejects, or a filter that
 * silently matches nothing, still passes there. Both happened in production
 * (support chat failed for everyone; the inbox came back empty). These tests
 * run the real queries:
 *   - customer and provider support chats: created, listed, reused, answered
 *   - booking chats: listed for both people on the booking
 *
 * Needs a throwaway database whose name ends in `_test`. Locally:
 *
 *   docker run -d --name ek-test-mongo -p 127.0.0.1:27018:27017 mongo:7.0 --replSet rs0 --bind_ip_all
 *   docker exec ek-test-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
 *   export TEST_DATABASE_URL="mongodb://localhost:27018/easykonnect_test?replicaSet=rs0&directConnection=true"
 *   DATABASE_URL="$TEST_DATABASE_URL" npx prisma db push --skip-generate
 *   npm run test:db
 *
 * Without TEST_DATABASE_URL the suite is skipped.
 */

import type { PrismaClient } from '@prisma/client';

// Real-time delivery and push notifications leave the process; the database
// work these tests are about does not
jest.mock('@/lib/socket', () => ({
  emitToConversation: jest.fn(),
  emitToUser: jest.fn(),
  sendNotification: jest.fn(),
  broadcastToAll: jest.fn(),
  getIO: () => null,
}));
jest.mock('@/services/push.service');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const databaseName = (url: string) => new URL(url.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);

const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDatabase('messaging against a real database', () => {
  let prisma: PrismaClient;
  let messaging: typeof import('@/services/messaging.service');

  const ids = { admin: '', customer: '', providerUser: '', provider: '', booking: '' };

  beforeAll(async () => {
    const url = TEST_DATABASE_URL as string;
    // Never let these tests near a real database
    if (!databaseName(url).endsWith('_test')) {
      throw new Error(`TEST_DATABASE_URL must name a database ending in _test, got "${databaseName(url)}"`);
    }
    process.env.DATABASE_URL = url;
    delete process.env.REQUIRE_TERMS_ACCEPTANCE;

    prisma = (await import('@/lib/prisma')).default;
    messaging = await import('@/services/messaging.service');

    // A clean slate for every run
    await prisma.message.deleteMany({});
    await prisma.conversation.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.report.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.service.deleteMany({});
    await prisma.serviceCategory.deleteMany({});
    await prisma.serviceProvider.deleteMany({});
    await prisma.user.deleteMany({});

    const person = (email: string, firstName: string, role: 'ADMIN' | 'SERVICE_USER' | 'SERVICE_PROVIDER') =>
      prisma.user.create({
        data: { email, password: 'not-used', firstName, lastName: 'Test', role, status: 'ACTIVE', isEmailVerified: true },
      });

    const admin = await person('support@example.test', 'Ada', 'ADMIN');
    const customer = await person('customer@example.test', 'Chidi', 'SERVICE_USER');
    const providerUser = await person('provider@example.test', 'Pat', 'SERVICE_PROVIDER');

    const provider = await prisma.serviceProvider.create({
      data: {
        userId: providerUser.id,
        businessName: 'Pat Plumbing',
        address: '1 Test Road',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        verificationStatus: 'VERIFIED',
      },
    });
    const category = await prisma.serviceCategory.create({ data: { name: 'Plumbing', slug: 'plumbing' } });
    const service = await prisma.service.create({
      data: {
        providerId: provider.id,
        categoryId: category.id,
        name: 'Plumbing Services',
        slug: 'plumbing-services',
        description: 'Leaks and fittings',
        price: 10000,
        duration: 60,
        status: 'ACTIVE',
      },
    });
    const booking = await prisma.booking.create({
      data: {
        userId: customer.id,
        providerId: provider.id,
        serviceId: service.id,
        scheduledDate: new Date('2026-10-01T09:00:00.000Z'),
        scheduledTime: '09:00',
        address: '2 Test Road',
        city: 'Lagos',
        state: 'Lagos',
        servicePrice: 10000,
        commission: 700,
        totalAmount: 10000,
        status: 'ACCEPTED',
      },
    });

    Object.assign(ids, {
      admin: admin.id,
      customer: customer.id,
      providerUser: providerUser.id,
      provider: provider.id,
      booking: booking.id,
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const inboxIds = async (userId: string) =>
    (await messaging.getMyConversations(userId, { page: 1, limit: 50 })).conversations.map((c) => c.id);

  const messageTexts = async (userId: string, conversationId: string) =>
    (await messaging.getConversationMessages(userId, conversationId)).messages.map((m) => m.content);

  const present = <T>(value: T | null | undefined): T => {
    expect(value).toBeTruthy();
    return value as T;
  };

  const startSupport = async (...args: Parameters<typeof messaging.startSupportConversation>) =>
    present(await messaging.startSupportConversation(...args));

  const bookingChat = async (...args: Parameters<typeof messaging.getBookingConversation>) =>
    present(await messaging.getBookingConversation(...args));

  describe('customer support chat', () => {
    let conversationId = '';

    it('starts a USER_ADMIN chat between the customer and an admin', async () => {
      const conversation = await startSupport(
        ids.customer,
        'SERVICE_USER',
        'EasyKonnet Support',
        'My refund is not in my wallet'
      );
      conversationId = conversation.id;

      expect(conversation.type).toBe('USER_ADMIN');
      expect(conversation.participantIds).toEqual(expect.arrayContaining([ids.customer, ids.admin]));
    });

    it('stores an empty archivedBy list, which the inbox filter needs', async () => {
      const stored = await prisma.conversation.findUnique({ where: { id: conversationId } });
      expect(stored?.archivedBy).toEqual([]);
    });

    it("shows the chat in the customer's and the admin's inbox", async () => {
      expect(await inboxIds(ids.customer)).toContain(conversationId);
      expect(await inboxIds(ids.admin)).toContain(conversationId);
    });

    it('reuses the open chat for a second request, and delivers the new message', async () => {
      const again = await startSupport(
        ids.customer,
        'SERVICE_USER',
        'EasyKonnet Support',
        'Any update?'
      );

      expect(again.id).toBe(conversationId);
      expect(await messageTexts(ids.customer, conversationId)).toEqual([
        'My refund is not in my wallet',
        'Any update?',
      ]);
    });

    it("counts the admin's reply as unread until the customer opens the chat", async () => {
      await messaging.sendMessage(ids.admin, 'ADMIN', { conversationId, content: 'We are looking into it' });

      expect((await messaging.getUnreadMessageCount(ids.customer)).count).toBe(1);
      // Opening the chat reads it
      expect(await messageTexts(ids.customer, conversationId)).toContain('We are looking into it');
      expect((await messaging.getUnreadMessageCount(ids.customer)).count).toBe(0);
    });
  });

  describe('provider support chat', () => {
    let conversationId = '';

    it('starts a USER_ADMIN chat for a provider and lists it in their inbox', async () => {
      const conversation = await startSupport(
        ids.providerUser,
        'SERVICE_PROVIDER',
        'Payout question',
        'When does my payout arrive?'
      );
      conversationId = conversation.id;

      expect(conversation.type).toBe('USER_ADMIN');
      expect(conversation.participantIds).toEqual(expect.arrayContaining([ids.providerUser, ids.admin]));
      expect(await inboxIds(ids.providerUser)).toContain(conversationId);
    });

    it("delivers the admin's reply to the provider", async () => {
      await messaging.sendMessage(ids.admin, 'ADMIN', { conversationId, content: 'It is scheduled for Friday' });

      expect(await messageTexts(ids.providerUser, conversationId)).toContain('It is scheduled for Friday');
    });
  });

  describe('booking chat', () => {
    let conversationId = '';

    it('opens the booking chat between the two user accounts on the booking', async () => {
      const conversation = await bookingChat(ids.customer, 'SERVICE_USER', ids.booking);
      conversationId = conversation.id;

      expect(conversation.type).toBe('BOOKING_RELATED');
      expect(conversation.bookingId).toBe(ids.booking);
      // User ids, never the provider's profile id
      expect(conversation.participantIds).toEqual([ids.customer, ids.providerUser]);
      expect(conversation.participantIds).not.toContain(ids.provider);
    });

    it('lists the chat for both people once a message is sent', async () => {
      await messaging.sendMessage(ids.customer, 'SERVICE_USER', { conversationId, content: 'Is 9am still fine?' });

      expect(await inboxIds(ids.customer)).toContain(conversationId);
      expect(await inboxIds(ids.providerUser)).toContain(conversationId);
    });

    it('gives the provider the same conversation when they open the booking', async () => {
      const fromProvider = await bookingChat(ids.providerUser, 'SERVICE_PROVIDER', ids.booking);

      expect(fromProvider.id).toBe(conversationId);
      expect(await messageTexts(ids.providerUser, conversationId)).toContain('Is 9am still fine?');
    });
  });
});
