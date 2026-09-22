/**
 * Prune stale push device ids
 *
 * Pushes are addressed by user id, so stored device ids are no longer used to
 * send. They are still shown to support and used by unregister, so ids that
 * no longer exist in the configured OneSignal app (an earlier app, an old
 * install) are removed here. Each id is checked with OneSignal first; only ids
 * OneSignal answers 404 for are removed.
 *
 * Needs an App API key (os_v2_app_…). Reports only, unless run with --apply:
 *
 *   npx ts-node --transpile-only -O '{"module":"commonjs","moduleResolution":"node"}' \
 *     scripts/prune-stale-push-devices.ts [--apply]
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const appId = process.env.ONESIGNAL_APP_ID ?? '';
const apiKey = process.env.ONESIGNAL_REST_API_KEY ?? '';

type DeviceState = 'current' | 'gone' | 'unknown';

const deviceState = async (deviceId: string): Promise<DeviceState> => {
  const response = await fetch(
    `https://api.onesignal.com/apps/${appId}/subscriptions/${encodeURIComponent(deviceId)}/user/identity`,
    { headers: { Authorization: `Key ${apiKey}` } }
  );
  if (response.ok) return 'current';
  if (response.status === 404) return 'gone';
  return 'unknown';
};

const main = async () => {
  if (!appId || !apiKey.startsWith('os_v2_app_')) {
    throw new Error('ONESIGNAL_APP_ID and an App API key (os_v2_app_…) are required');
  }

  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { OR: [{ oneSignalPlayerId: { not: null } }, { oneSignalPlayerIds: { isEmpty: false } }] },
      select: { id: true, oneSignalPlayerId: true, oneSignalPlayerIds: true },
    });

    let kept = 0;
    let removed = 0;
    let unknown = 0;

    for (const user of users) {
      const devices = [...(user.oneSignalPlayerIds ?? [])];
      if (user.oneSignalPlayerId && !devices.includes(user.oneSignalPlayerId)) {
        devices.push(user.oneSignalPlayerId);
      }

      const remaining: string[] = [];
      for (const deviceId of devices) {
        const state = await deviceState(deviceId);
        if (state === 'gone') {
          removed++;
          continue;
        }
        if (state === 'unknown') unknown++;
        else kept++;
        // Anything OneSignal didn't clearly reject is kept
        remaining.push(deviceId);
      }

      if (apply && remaining.length !== devices.length) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            oneSignalPlayerIds: remaining,
            oneSignalPlayerId: remaining[remaining.length - 1] ?? null,
          },
        });
      }
    }

    console.log(
      `${users.length} users with device ids: ${kept} current, ${removed} stale${apply ? ' (removed)' : ' (would be removed; run with --apply)'}, ${unknown} unchecked`
    );
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
