/**
 * Presence and socket records expire on their own within a few minutes, so a server that
 * stops without a clean shutdown can't leave users online
 */

import RedisClient, { presence, session } from '@/lib/redis';

const NOW = 1_789_207_200_000;

interface FakeTransaction {
  zadd: jest.Mock;
  expire: jest.Mock;
  zremrangebyscore: jest.Mock;
  zrange: jest.Mock;
  exec: jest.Mock;
}

const createTransaction = (results: [Error | null, unknown][] | null): FakeTransaction => {
  const transaction: FakeTransaction = {
    zadd: jest.fn(() => transaction),
    expire: jest.fn(() => transaction),
    zremrangebyscore: jest.fn(() => transaction),
    zrange: jest.fn(() => transaction),
    exec: jest.fn().mockResolvedValue(results),
  };
  return transaction;
};

const useClient = (client: Record<string, unknown>) =>
  jest.spyOn(RedisClient, 'connect').mockResolvedValue(client as never);

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('presence', () => {
  it('keeps a user online for three minutes after connecting or a heartbeat', async () => {
    const client = { setex: jest.fn().mockResolvedValue('OK') };
    useClient(client);

    await presence.setOnline('user-1');

    expect(presence.ONLINE_TTL).toBe(180);
    expect(client.setex).toHaveBeenCalledWith('presence:user-1', 180, String(NOW));
  });
});

describe('socket records', () => {
  it('last a few minutes, not days', () => {
    expect(session.SESSION_TTL).toBe(180);
  });

  it('record each socket with its own expiry', async () => {
    const transaction = createTransaction([[null, 1], [null, 1]]);
    useClient({ multi: jest.fn(() => transaction) });

    await session.setSocket('user-1', 'socket-1');

    expect(transaction.zadd).toHaveBeenCalledWith('sockets:user:user-1', NOW + 180_000, 'socket-1');
    expect(transaction.expire).toHaveBeenCalledWith('sockets:user:user-1', 180);
    expect(transaction.exec).toHaveBeenCalled();
  });

  it('list only sockets whose records have not expired', async () => {
    const transaction = createTransaction([[null, 2], [null, ['socket-2']]]);
    useClient({ multi: jest.fn(() => transaction) });

    await expect(session.getSockets('user-1')).resolves.toEqual(['socket-2']);

    expect(transaction.zremrangebyscore).toHaveBeenCalledWith('sockets:user:user-1', '-inf', NOW);
    expect(transaction.zrange).toHaveBeenCalledWith('sockets:user:user-1', 0, -1);
  });

  it('fail loudly when Redis rejects a command or the transaction', async () => {
    useClient({ multi: jest.fn(() => createTransaction([[null, 0], [new Error('WRONGTYPE'), null]])) });
    await expect(session.getSockets('user-1')).rejects.toThrow('WRONGTYPE');

    useClient({ multi: jest.fn(() => createTransaction(null)) });
    await expect(session.setSocket('user-1', 'socket-1')).rejects.toThrow('aborted');
  });

  it('remove a disconnected socket', async () => {
    const client = { zrem: jest.fn().mockResolvedValue(1) };
    useClient(client);

    await session.removeSocket('user-1', 'socket-1');

    expect(client.zrem).toHaveBeenCalledWith('sockets:user:user-1', 'socket-1');
  });
});
