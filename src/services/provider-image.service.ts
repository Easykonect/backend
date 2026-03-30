import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { uploadMultipleFiles, deleteFile } from './upload.service';

/**
 * Extract Cloudinary public_id from URL
 */
const extractPublicId = (url: string): string | null => {
  try {
    const regex = /\/v\d+\/(.+)\.\w+$/;
    const match = url.match(regex);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

/**
 * Upload provider gallery images
 */
export const uploadProviderImages = async (
  userId: string,
  files: Array<{ base64Data: string; filename: string }>
): Promise<string[]> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  const maxImages = 10;
  const currentCount = provider.images.length;
  if (currentCount + files.length > maxImages) {
    throw new GraphQLError(
      `Maximum ${maxImages} images allowed. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_IMAGES_EXCEEDED' } }
    );
  }

  const results = await uploadMultipleFiles(files, 'service', userId, maxImages);
  const newUrls = results.map((r) => r.url);

  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      images: [...provider.images, ...newUrls],
    },
  });

  return newUrls;
};

/**
 * Remove a provider gallery image
 */
export const removeProviderImage = async (
  userId: string,
  imageUrl: string
): Promise<boolean> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!provider.images.includes(imageUrl)) {
    throw new GraphQLError('Image not found in provider gallery', {
      extensions: { code: 'IMAGE_NOT_FOUND' },
    });
  }

  // Delete from Cloudinary
  const publicId = extractPublicId(imageUrl);
  if (publicId) {
    await deleteFile(publicId);
  }

  // Remove from provider
  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      images: provider.images.filter((img) => img !== imageUrl),
    },
  });

  return true;
};
