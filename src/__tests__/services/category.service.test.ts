/**
 * Category Service Tests
 *
 * Covers:
 *   - category names allow & , / ( ) and accented letters
 *   - slugs keep accented letters as plain letters, and fall back to a random
 *     suffix for names with nothing a slug can use
 *   - renaming rebuilds the slug; other edits keep it
 *   - inactive categories are only listed when asked for
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceCategory: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));

import prisma from '@/lib/prisma';
import { createCategory, getCategories, updateCategory } from '@/services/category.service';

const CATEGORY_ID = '64f1c2a9e4b0a1b2c3d4e601';

const categoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: CATEGORY_ID,
  name: 'Cleaning',
  slug: 'cleaning',
  description: null,
  icon: null,
  isActive: true,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
  (prisma.serviceCategory.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.serviceCategory.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.serviceCategory.count as jest.Mock).mockResolvedValue(0);
  (prisma.serviceCategory.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    categoryRow(data)
  );
  (prisma.serviceCategory.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    categoryRow(data)
  );
});

describe('createCategory — names and slugs', () => {
  it.each([
    ['Hair & Beauty', 'hair-beauty'],
    ['AC/Fridge Repair', 'ac-fridge-repair'],
    ['Painting, Plastering (POP)', 'painting-plastering-pop'],
    ['Ọ̀ṣọ́ Ilé', 'oso-ile'],
  ])('accepts "%s" with the slug "%s"', async (name, slug) => {
    const category = await createCategory({ name });

    expect(prisma.serviceCategory.create).toHaveBeenCalledWith({
      data: { name, slug, description: undefined, icon: undefined, isActive: true },
    });
    expect(category.slug).toBe(slug);
  });

  it('falls back to a random slug for a name without letters or digits', async () => {
    const category = await createCategory({ name: '...' });

    expect(category.slug).toMatch(/^category-[0-9a-f]{8}$/);
  });

  it.each(['Cleaning!', 'Plumbing @ Home', '50% Off'])('refuses "%s"', async (name) => {
    await expect(createCategory({ name })).rejects.toMatchObject({
      message: 'Category name contains invalid characters',
      extensions: { code: 'INVALID_INPUT' },
    });
    expect(prisma.serviceCategory.create).not.toHaveBeenCalled();
  });

  it('refuses a name or slug another category has', async () => {
    (prisma.serviceCategory.findFirst as jest.Mock).mockResolvedValue(categoryRow({ name: 'Hair and Beauty' }));

    await expect(createCategory({ name: 'Hair & Beauty' })).rejects.toMatchObject({
      extensions: { code: 'DUPLICATE_CATEGORY' },
    });
  });
});

describe('updateCategory — slugs', () => {
  it('keeps the slug and skips the duplicate check when the name is unchanged', async () => {
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue(categoryRow({ slug: 'cleaning-services' }));

    await updateCategory(CATEGORY_ID, { name: 'Cleaning', isActive: false });

    expect(prisma.serviceCategory.findFirst).not.toHaveBeenCalled();
    expect(prisma.serviceCategory.update).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
      data: { isActive: false },
    });
  });

  it('rebuilds the slug from a new name', async () => {
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue(categoryRow());

    await updateCategory(CATEGORY_ID, { name: 'Home & Office Cleaning' });

    expect(prisma.serviceCategory.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: CATEGORY_ID },
        OR: [
          { name: { equals: 'Home & Office Cleaning', mode: 'insensitive' } },
          { slug: 'home-office-cleaning' },
        ],
      },
    });
    expect(prisma.serviceCategory.update).toHaveBeenCalledWith({
      where: { id: CATEGORY_ID },
      data: { name: 'Home & Office Cleaning', slug: 'home-office-cleaning' },
    });
  });

  it('refuses a new name another category has', async () => {
    (prisma.serviceCategory.findUnique as jest.Mock).mockResolvedValue(categoryRow());
    (prisma.serviceCategory.findFirst as jest.Mock).mockResolvedValue(categoryRow({ id: '64f1c2a9e4b0a1b2c3d4e602' }));

    await expect(updateCategory(CATEGORY_ID, { name: 'Home Cleaning' })).rejects.toMatchObject({
      extensions: { code: 'DUPLICATE_CATEGORY' },
    });
    expect(prisma.serviceCategory.update).not.toHaveBeenCalled();
  });
});

describe('getCategories — inactive categories', () => {
  it('lists active categories by default', async () => {
    await getCategories({ page: 1, limit: 50 });

    expect(prisma.serviceCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true }, orderBy: { name: 'asc' } })
    );
  });

  it('lists every category when asked', async () => {
    await getCategories({ page: 1, limit: 50 }, true);

    expect(prisma.serviceCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(prisma.serviceCategory.count).toHaveBeenCalledWith({ where: {} });
  });
});
