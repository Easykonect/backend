/**
 * Nearby search bounding box
 */

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

import { boundingBox, haversineDistance } from '@/services/browse.service';

describe('boundingBox', () => {
  const lagos = { latitude: 6.5244, longitude: 3.3792 };

  it('reaches the edge of the search radius in every direction', () => {
    const box = boundingBox(lagos.latitude, lagos.longitude, 25);

    expect(haversineDistance(lagos.latitude, lagos.longitude, box.latitude.lte, lagos.longitude)).toBeGreaterThanOrEqual(24.9);
    expect(haversineDistance(lagos.latitude, lagos.longitude, lagos.latitude, box.longitude.lte)).toBeGreaterThanOrEqual(24.9);
    expect(box.latitude.gte).toBeLessThan(lagos.latitude);
    expect(box.longitude.gte).toBeLessThan(lagos.longitude);
  });

  it('widens the longitude range away from the equator', () => {
    const atEquator = boundingBox(0, 0, 50);
    const farNorth = boundingBox(60, 0, 50);

    const width = (box: ReturnType<typeof boundingBox>) => box.longitude.lte - box.longitude.gte;
    expect(width(farNorth)).toBeGreaterThan(width(atEquator));
  });
});
