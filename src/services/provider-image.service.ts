import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { uploadMultipleFiles, deleteOwnedFile, discardUploads } from './upload.service';

const MAX_GALLERY_IMAGES = 10;

const providerNotFound = () =>
  new GraphQLError('Provider profile not found', {
    extensions: { code: 'PROVIDER_NOT_FOUND' },
  });

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
    throw providerNotFound();
  }

  const currentCount = provider.images.length;
  if (currentCount + files.length > MAX_GALLERY_IMAGES) {
    throw new GraphQLError(
      `Maximum ${MAX_GALLERY_IMAGES} images allowed. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_IMAGES_EXCEEDED' } }
    );
  }

  const results = await uploadMultipleFiles(files, 'service', userId, MAX_GALLERY_IMAGES);
  const newUrls = results.map((r) => r.url);

  try {
    await prisma.serviceProvider.update({
      where: { userId },
      data: {
        images: [...provider.images, ...newUrls],
      },
    });
  } catch (error) {
    // Don't leave files on Cloudinary that nothing refers to
    await discardUploads(results);
    throw error;
  }

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
    throw providerNotFound();
  }

  if (!provider.images.includes(imageUrl)) {
    throw new GraphQLError('Image not found in provider gallery', {
      extensions: { code: 'IMAGE_NOT_FOUND' },
    });
  }

  // Remove from provider
  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      images: provider.images.filter((img) => img !== imageUrl),
    },
  });

  // Delete from Cloudinary (only files this provider uploaded)
  await deleteOwnedFile(imageUrl, userId);

  return true;
};
