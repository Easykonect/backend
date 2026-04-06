/**
 * Service Category Service
 * Handles service category CRUD operations (Admin only)
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { sanitizeStrict, sanitizeBasic, validateName, validateText, validateUrl, MAX_LENGTHS } from '@/utils/security';

// ==================
// Types
// ==================

interface CreateCategoryInput {
  name: string;
  description?: string;
  icon?: string;
}

interface UpdateCategoryInput {
  name?: string;
  description?: string;
  icon?: string;
  isActive?: boolean;
}

// ==================
// Helper Functions
// ==================

/**
 * Generate slug from name
 */
const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
};

/**
 * Format category response
 */
const formatCategory = (category: any) => ({
  id: category.id,
  name: category.name,
  slug: category.slug,
  description: category.description,
  icon: category.icon,
  isActive: category.isActive,
  createdAt: category.createdAt.toISOString(),
  updatedAt: category.updatedAt.toISOString(),
});

// ==================
// Category Functions
// ==================

/**
 * Get All Categories
 */
export const getCategories = async (pagination: { page: number; limit: number }, includeInactive = false) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where = includeInactive ? {} : { isActive: true };

  const [items, total] = await Promise.all([
    prisma.serviceCategory.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.serviceCategory.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    items: items.map(formatCategory),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Get Category by ID
 */
export const getCategoryById = async (categoryId: string) => {
  const category = await prisma.serviceCategory.findUnique({
    where: { id: categoryId },
  });

  if (!category) {
    throw new GraphQLError('Category not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatCategory(category);
};

/**
 * Create Category (Admin only)
 */
export const createCategory = async (input: CreateCategoryInput) => {
  const { name, description, icon } = input;

  // Sanitize and validate inputs
  const sanitizedName = validateName(name, 'Category name');
  const sanitizedDescription = description 
    ? validateText(sanitizeBasic(description), 'Description', MAX_LENGTHS.MEDIUM_TEXT)
    : undefined;
  const sanitizedIcon = icon ? validateUrl(icon) : undefined;

  // Generate slug
  const slug = generateSlug(sanitizedName);

  // Check if category with same name or slug exists
  const existing = await prisma.serviceCategory.findFirst({
    where: {
      OR: [
        { name: { equals: sanitizedName, mode: 'insensitive' } },
        { slug },
      ],
    },
  });

  if (existing) {
    throw new GraphQLError('A category with this name already exists', {
      extensions: { code: 'DUPLICATE_CATEGORY' },
    });
  }

  const category = await prisma.serviceCategory.create({
    data: {
      name: sanitizedName,
      slug,
      description: sanitizedDescription,
      icon: sanitizedIcon,
      isActive: true,
    },
  });

  return formatCategory(category);
};

/**
 * Update Category (Admin only)
 */
export const updateCategory = async (categoryId: string, input: UpdateCategoryInput) => {
  const category = await prisma.serviceCategory.findUnique({
    where: { id: categoryId },
  });

  if (!category) {
    throw new GraphQLError('Category not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Build update data with sanitization
  const updateData: any = {};

  if (input.name !== undefined) {
    updateData.name = validateName(input.name, 'Category name');
    updateData.slug = generateSlug(updateData.name);

    // Check for duplicate
    const existing = await prisma.serviceCategory.findFirst({
      where: {
        id: { not: categoryId },
        OR: [
          { name: { equals: updateData.name, mode: 'insensitive' } },
          { slug: updateData.slug },
        ],
      },
    });

    if (existing) {
      throw new GraphQLError('A category with this name already exists', {
        extensions: { code: 'DUPLICATE_CATEGORY' },
      });
    }
  }

  if (input.description !== undefined) {
    updateData.description = validateText(
      sanitizeBasic(input.description),
      'Description',
      MAX_LENGTHS.MEDIUM_TEXT
    );
  }
  if (input.icon !== undefined) {
    updateData.icon = input.icon ? validateUrl(input.icon) : null;
  }
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  const updated = await prisma.serviceCategory.update({
    where: { id: categoryId },
    data: updateData,
  });

  return formatCategory(updated);
};

/**
 * Delete Category (Admin only)
 */
export const deleteCategory = async (categoryId: string) => {
  const category = await prisma.serviceCategory.findUnique({
    where: { id: categoryId },
    include: {
      _count: { select: { services: true } },
    },
  });

  if (!category) {
    throw new GraphQLError('Category not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if category has services
  if (category._count.services > 0) {
    throw new GraphQLError(
      `Cannot delete category with ${category._count.services} service(s). Please reassign or delete services first.`,
      { extensions: { code: 'HAS_SERVICES' } }
    );
  }

  await prisma.serviceCategory.delete({
    where: { id: categoryId },
  });

  return {
    success: true,
    message: `Category "${category.name}" has been deleted.`,
  };
};
