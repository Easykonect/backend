/**
 * Upload Service
 * Handles file uploads to Cloudinary
 * 
 * Features:
 * - Profile photo uploads (users)
 * - Service image uploads (providers)
 * - Document uploads (provider verification)
 * - Evidence uploads (disputes)
 * - Secure signed URLs for private files
 * - Image optimization and transformation
 */

import { GraphQLError } from 'graphql';
import cloudinary, { CloudinaryFolders, CloudinaryTransformations } from '@/lib/cloudinary';
import prisma from '@/lib/prisma';
import { config } from '@/config';

// ==================
// Types
// ==================

export interface UploadResult {
  url: string;
  publicId: string;
  format: string;
  width?: number;
  height?: number;
  bytes: number;
  resourceType: string;
}

export interface SignedUploadParams {
  signature: string;
  timestamp: number;
  cloudName: string;
  apiKey: string;
  folder: string;
  uploadPreset?: string;
}

type UploadType = 'profile' | 'service' | 'document' | 'evidence';

// File size limits (in bytes)
const FILE_SIZE_LIMITS = {
  profile: 5 * 1024 * 1024,     // 5MB
  service: 10 * 1024 * 1024,    // 10MB
  document: 15 * 1024 * 1024,   // 15MB
  evidence: 15 * 1024 * 1024,   // 15MB
};

// Allowed formats for each upload type
const ALLOWED_FORMATS = {
  profile: ['jpg', 'jpeg', 'png', 'webp'],
  service: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  document: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
  evidence: ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov'],
};

// ==================
// Helper Functions
// ==================

/**
 * Get folder path for upload type
 */
const getFolderPath = (type: UploadType): string => {
  switch (type) {
    case 'profile':
      return CloudinaryFolders.PROFILES;
    case 'service':
      return CloudinaryFolders.SERVICES;
    case 'document':
      return CloudinaryFolders.DOCUMENTS;
    case 'evidence':
      return CloudinaryFolders.EVIDENCE;
    default:
      return 'easykonect/misc';
  }
};

/**
 * Get resource type for upload
 */
const getResourceType = (type: UploadType): 'image' | 'video' | 'raw' | 'auto' => {
  switch (type) {
    case 'profile':
    case 'service':
      return 'image';
    case 'document':
    case 'evidence':
      return 'auto';
    default:
      return 'auto';
  }
};

/**
 * Validate file format
 */
const validateFormat = (filename: string, type: UploadType): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  return ALLOWED_FORMATS[type].includes(ext);
};

/**
 * Format upload result
 */
const formatUploadResult = (result: any): UploadResult => ({
  url: result.secure_url,
  publicId: result.public_id,
  format: result.format,
  width: result.width,
  height: result.height,
  bytes: result.bytes,
  resourceType: result.resource_type,
});

// ==================
// Upload Functions
// ==================

/**
 * Upload a file from base64 data
 */
export const uploadFile = async (
  base64Data: string,
  type: UploadType,
  filename: string,
  userId: string
): Promise<UploadResult> => {
  // Validate format
  if (!validateFormat(filename, type)) {
    throw new GraphQLError(
      `Invalid file format. Allowed formats for ${type}: ${ALLOWED_FORMATS[type].join(', ')}`,
      { extensions: { code: 'INVALID_FILE_FORMAT' } }
    );
  }

  // Check if base64 data includes data URI prefix
  let uploadData = base64Data;
  if (!base64Data.startsWith('data:')) {
    // Guess mime type from filename
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      pdf: 'application/pdf',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
    };
    const mimeType = mimeTypes[ext || ''] || 'application/octet-stream';
    uploadData = `data:${mimeType};base64,${base64Data}`;
  }

  // Estimate file size from base64
  const base64Length = base64Data.replace(/^data:.*?;base64,/, '').length;
  const estimatedSize = (base64Length * 3) / 4;
  
  if (estimatedSize > FILE_SIZE_LIMITS[type]) {
    const maxSizeMB = FILE_SIZE_LIMITS[type] / (1024 * 1024);
    throw new GraphQLError(
      `File size exceeds maximum allowed (${maxSizeMB}MB)`,
      { extensions: { code: 'FILE_TOO_LARGE' } }
    );
  }

  try {
    const folder = getFolderPath(type);
    const resourceType = getResourceType(type);
    
    // Build upload options
    const uploadOptions: any = {
      folder,
      resource_type: resourceType,
      public_id: `${userId}_${Date.now()}`,
      overwrite: true,
    };

    // Add transformations for images
    if (type === 'profile') {
      uploadOptions.transformation = CloudinaryTransformations.PROFILE;
    } else if (type === 'service') {
      uploadOptions.eager = [
        { transformation: CloudinaryTransformations.SERVICE_THUMBNAIL },
        { transformation: CloudinaryTransformations.SERVICE_FULL },
      ];
    }

    const result = await cloudinary.uploader.upload(uploadData, uploadOptions);
    
    return formatUploadResult(result);
  } catch (error: any) {
    console.error('Cloudinary upload error:', error);
    throw new GraphQLError(
      error.message || 'Failed to upload file',
      { extensions: { code: 'UPLOAD_FAILED' } }
    );
  }
};

/**
 * Upload multiple files
 */
export const uploadMultipleFiles = async (
  files: Array<{ base64Data: string; filename: string }>,
  type: UploadType,
  userId: string,
  maxFiles: number = 10
): Promise<UploadResult[]> => {
  if (files.length > maxFiles) {
    throw new GraphQLError(
      `Maximum ${maxFiles} files allowed per upload`,
      { extensions: { code: 'TOO_MANY_FILES' } }
    );
  }

  const results: UploadResult[] = [];
  
  for (const file of files) {
    const result = await uploadFile(file.base64Data, type, file.filename, userId);
    results.push(result);
  }

  return results;
};

/**
 * Delete a file from Cloudinary
 */
export const deleteFile = async (publicId: string): Promise<boolean> => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result.result === 'ok';
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    return false;
  }
};

/**
 * Delete multiple files
 */
export const deleteMultipleFiles = async (publicIds: string[]): Promise<boolean> => {
  try {
    await cloudinary.api.delete_resources(publicIds);
    return true;
  } catch (error) {
    console.error('Cloudinary batch delete error:', error);
    return false;
  }
};

/**
 * Generate signed upload parameters for client-side upload
 * This allows direct upload from frontend to Cloudinary
 */
export const generateSignedUploadParams = (
  type: UploadType,
  userId: string
): SignedUploadParams => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  const folder = getFolderPath(type);
  
  const paramsToSign = {
    timestamp,
    folder,
    public_id: `${userId}_${Date.now()}`,
  };

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    config.cloudinary.apiSecret
  );

  return {
    signature,
    timestamp,
    cloudName: config.cloudinary.cloudName,
    apiKey: config.cloudinary.apiKey,
    folder,
  };
};

// ==================
// Profile Photo Functions
// ==================

/**
 * Upload user profile photo
 */
export const uploadProfilePhoto = async (
  userId: string,
  base64Data: string,
  filename: string
): Promise<{ url: string; publicId: string }> => {
  // Get current user to check for existing photo
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { profilePhoto: true },
  });

  // Upload new photo
  const result = await uploadFile(base64Data, 'profile', filename, userId);

  // Update user with new photo URL
  await prisma.user.update({
    where: { id: userId },
    data: { profilePhoto: result.url },
  });

  // Delete old photo if exists (extract public_id from URL)
  if (user?.profilePhoto) {
    const oldPublicId = extractPublicIdFromUrl(user.profilePhoto);
    if (oldPublicId) {
      await deleteFile(oldPublicId);
    }
  }

  return { url: result.url, publicId: result.publicId };
};

/**
 * Remove user profile photo
 */
export const removeProfilePhoto = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { profilePhoto: true },
  });

  if (!user?.profilePhoto) {
    throw new GraphQLError('No profile photo to remove', {
      extensions: { code: 'NO_PHOTO' },
    });
  }

  // Delete from Cloudinary
  const publicId = extractPublicIdFromUrl(user.profilePhoto);
  if (publicId) {
    await deleteFile(publicId);
  }

  // Update user
  await prisma.user.update({
    where: { id: userId },
    data: { profilePhoto: null },
  });

  return true;
};

// ==================
// Service Image Functions
// ==================

/**
 * Upload service images
 */
export const uploadServiceImages = async (
  userId: string,
  serviceId: string,
  files: Array<{ base64Data: string; filename: string }>
): Promise<string[]> => {
  // Verify user owns the service
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { provider: true },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (service.provider.userId !== userId) {
    throw new GraphQLError('You can only upload images to your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  // Check total image count
  const maxImages = 10;
  const currentCount = service.images.length;
  if (currentCount + files.length > maxImages) {
    throw new GraphQLError(
      `Maximum ${maxImages} images allowed per service. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_IMAGES_EXCEEDED' } }
    );
  }

  // Upload images
  const results = await uploadMultipleFiles(files, 'service', userId, maxImages);
  const newUrls = results.map((r) => r.url);

  // Update service with new images
  await prisma.service.update({
    where: { id: serviceId },
    data: {
      images: [...service.images, ...newUrls],
    },
  });

  return newUrls;
};

/**
 * Remove a service image
 */
export const removeServiceImage = async (
  userId: string,
  serviceId: string,
  imageUrl: string
): Promise<boolean> => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { provider: true },
  });

  if (!service) {
    throw new GraphQLError('Service not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (service.provider.userId !== userId) {
    throw new GraphQLError('You can only remove images from your own services', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  if (!service.images.includes(imageUrl)) {
    throw new GraphQLError('Image not found in service', {
      extensions: { code: 'IMAGE_NOT_FOUND' },
    });
  }

  // Delete from Cloudinary
  const publicId = extractPublicIdFromUrl(imageUrl);
  if (publicId) {
    await deleteFile(publicId);
  }

  // Update service
  await prisma.service.update({
    where: { id: serviceId },
    data: {
      images: service.images.filter((img) => img !== imageUrl),
    },
  });

  return true;
};

// ==================
// Provider Document Functions
// ==================

/**
 * Upload provider verification documents
 */
export const uploadProviderDocuments = async (
  userId: string,
  files: Array<{ base64Data: string; filename: string }>
): Promise<string[]> => {
  // Get provider
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check total document count
  const maxDocuments = 5;
  const currentCount = provider.documents.length;
  if (currentCount + files.length > maxDocuments) {
    throw new GraphQLError(
      `Maximum ${maxDocuments} documents allowed. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_DOCUMENTS_EXCEEDED' } }
    );
  }

  // Upload documents
  const results = await uploadMultipleFiles(files, 'document', userId, maxDocuments);
  const newUrls = results.map((r) => r.url);

  // Update provider with new documents
  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      documents: [...provider.documents, ...newUrls],
    },
  });

  return newUrls;
};

/**
 * Remove a provider document
 */
export const removeProviderDocument = async (
  userId: string,
  documentUrl: string
): Promise<boolean> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw new GraphQLError('Provider profile not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (!provider.documents.includes(documentUrl)) {
    throw new GraphQLError('Document not found', {
      extensions: { code: 'DOCUMENT_NOT_FOUND' },
    });
  }

  // Delete from Cloudinary
  const publicId = extractPublicIdFromUrl(documentUrl);
  if (publicId) {
    await deleteFile(publicId);
  }

  // Update provider
  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      documents: provider.documents.filter((doc) => doc !== documentUrl),
    },
  });

  return true;
};

// ==================
// Dispute Evidence Functions
// ==================

/**
 * Upload dispute evidence (called from dispute service)
 */
export const uploadDisputeEvidence = async (
  userId: string,
  files: Array<{ base64Data: string; filename: string }>
): Promise<string[]> => {
  const maxEvidence = 10;
  
  if (files.length > maxEvidence) {
    throw new GraphQLError(
      `Maximum ${maxEvidence} evidence files allowed per upload`,
      { extensions: { code: 'MAX_EVIDENCE_EXCEEDED' } }
    );
  }

  const results = await uploadMultipleFiles(files, 'evidence', userId, maxEvidence);
  return results.map((r) => r.url);
};

// ==================
// Utility Functions
// ==================

/**
 * Extract public_id from Cloudinary URL
 */
const extractPublicIdFromUrl = (url: string): string | null => {
  try {
    // Cloudinary URL format: https://res.cloudinary.com/{cloud_name}/image/upload/v{version}/{public_id}.{format}
    const regex = /\/v\d+\/(.+)\.\w+$/;
    const match = url.match(regex);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

/**
 * Get optimized image URL with transformations
 */
export const getOptimizedImageUrl = (
  url: string,
  options: {
    width?: number;
    height?: number;
    crop?: string;
    quality?: string;
    format?: string;
  } = {}
): string => {
  try {
    const { width, height, crop = 'fill', quality = 'auto', format = 'auto' } = options;
    
    // Parse URL and insert transformations
    const transformations = [];
    if (width) transformations.push(`w_${width}`);
    if (height) transformations.push(`h_${height}`);
    transformations.push(`c_${crop}`);
    transformations.push(`q_${quality}`);
    transformations.push(`f_${format}`);
    
    const transformStr = transformations.join(',');
    
    // Insert transformation after /upload/
    return url.replace('/upload/', `/upload/${transformStr}/`);
  } catch {
    return url;
  }
};

/**
 * Get upload statistics for admin dashboard
 */
export const getUploadStats = async (): Promise<{
  totalProfiles: number;
  totalServiceImages: number;
  totalDocuments: number;
}> => {
  const [profileCount, services, providers] = await Promise.all([
    prisma.user.count({
      where: { profilePhoto: { not: null } },
    }),
    prisma.service.findMany({
      select: { images: true },
    }),
    prisma.serviceProvider.findMany({
      select: { documents: true },
    }),
  ]);

  // Calculate total service images
  const totalServiceImages = services.reduce((sum, s) => sum + s.images.length, 0);

  // Calculate total documents
  const totalDocuments = providers.reduce((sum, p) => sum + p.documents.length, 0);

  return {
    totalProfiles: profileCount,
    totalServiceImages,
    totalDocuments,
  };
};
