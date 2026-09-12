/**
 * Socket events from processes without the Socket.IO server
 */

jest.mock('@socket.io/redis-emitter', () => {
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  return { Emitter: jest.fn().mockImplementation(() => ({ to, emit })) };
});

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
  redisPubSub: {},
  presence: {},
  session: {},
  typing: {},
}));

import { Emitter } from '@socket.io/redis-emitter';
import RedisClient from '@/lib/redis';
import { emitToUser } from '@/lib/socket';

describe('emitToUser without a local Socket.IO server', () => {
  it('publishes through Redis and survives a failed publish', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('Redis unavailable'));
    (RedisClient.getInstance as jest.Mock).mockReturnValue({ publish });

    await emitToUser('user-1', 'booking:accepted', { bookingId: 'booking-1' });

    const EmitterMock = Emitter as unknown as jest.Mock;
    const instance = EmitterMock.mock.results[0].value;
    expect(instance.to).toHaveBeenCalledWith('user:user-1');

    // The client handed to the emitter catches publish errors
    const client = EmitterMock.mock.calls[0][0];
    await expect(client.publish('socket.io#/#user:user-1#', 'payload')).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalled();
  });
});
