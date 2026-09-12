/**
 * Upload Service
 * Handles file uploads to Cloudinary
 *
 * Features:
 * - Profile photo uploads (users)
 * - Service image uploads (providers)
 * - Document uploads (provider verification), stored as authenticated assets
 *   and shown through short-lived download links
 * - Evidence uploads (disputes)
 * - Signed parameters for uploading straight to Cloudinary
 * - Image optimization and transformation
 */

import { randomBytes } from 'crypto';
import { GraphQLError } from 'graphql';
import type { UploadApiOptions, UploadApiResponse } from 'cloudinary';
import cloudinary, { CloudinaryFolders, CloudinaryTransformations } from '@/lib/cloudinary';
import prisma from '@/lib/prisma';
import { config } from '@/config';
import { ServiceStatus } from '@/constants';
import { flagContent } from '@/services/report.service';
import { assertTermsAccepted } from '@/services/terms.service';

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
  // Delivery type: 'upload' (public) or 'authenticated' (private)
  type: string;
}

export interface SignedUploadParams {
  signature: string;
  timestamp: number;
  cloudName: string;
  apiKey: string;
  folder: string;
  publicId: string;
  allowedFormats: string;
  type: string;
  overwrite: boolean;
  uploadUrl: string;
  uploadPreset?: string;
}

/**
 * A file on Cloudinary, identified from its delivery URL
 */
export interface CloudinaryAsset {
  cloudName: string;
  resourceType: 'image' | 'video' | 'raw';
  type: string;
  version: string | null;
  publicId: string;
  format: string | null;
}

type UploadType = 'profile' | 'service' | 'document' | 'evidence';

type DeletableAsset = Pick<CloudinaryAsset, 'resourceType' | 'type'>;

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

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const MAX_SERVICE_IMAGES = 10;
const MAX_PROVIDER_DOCUMENTS = 5;

// How long a link to a private verification document keeps working
export const DOCUMENT_LINK_TTL_SECONDS = 30 * 60;

const MAX_URL_LENGTH = 2048;

const RESOURCE_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'raw']);

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
 * Resource type used in the upload endpoint
 */
const getResourceType = (type: UploadType): 'image' | 'auto' =>
  type === 'profile' || type === 'service' ? 'image' : 'auto';

/**
 * Verification documents are authenticated assets: Cloudinary only delivers
 * them through signed links. Everything else is public.
 */
const getDeliveryType = (type: UploadType): 'upload' | 'authenticated' =>
  type === 'document' ? 'authenticated' : 'upload';

/**
 * Cloudinary file name for a new upload. It starts with the uploader's ID, which
 * is how ownership is checked later; the random part keeps two uploads made in
 * the same millisecond apart.
 */
const newPublicId = (userId: string): string =>
  `${userId}_${Date.now()}_${randomBytes(3).toString('hex')}`;

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
const formatUploadResult = (result: UploadApiResponse): UploadResult => ({
  url: result.secure_url,
  publicId: result.public_id,
  format: result.format,
  width: result.width,
  height: result.height,
  bytes: result.bytes,
  resourceType: result.resource_type,
  type: result.type,
});

const providerNotFound = () =>
  new GraphQLError('Provider profile not found', {
    extensions: { code: 'PROVIDER_NOT_FOUND' },
  });

/**
 * Check a base64 file's format and size, and return it as a data URI
 */
const prepareFile = (base64Data: string, type: UploadType, filename: string): string => {
  if (!validateFormat(filename, type)) {
    throw new GraphQLError(
      `Invalid file format. Allowed formats for ${type}: ${ALLOWED_FORMATS[type].join(', ')}`,
      { extensions: { code: 'INVALID_FILE_FORMAT' } }
    );
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

  if (base64Data.startsWith('data:')) return base64Data;

  // Without a data URI prefix, guess the MIME type from the filename
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return `data:${MIME_TYPES[ext] ?? 'application/octet-stream'};base64,${base64Data}`;
};

/**
 * Upload one prepared file
 */
const sendToCloudinary = async (
  uploadData: string,
  type: UploadType,
  userId: string
): Promise<UploadResult> => {
  const uploadOptions: UploadApiOptions = {
    folder: getFolderPath(type),
    resource_type: getResourceType(type),
    type: getDeliveryType(type),
    public_id: newPublicId(userId),
    overwrite: true,
  };

  // Add transformations for images
  if (type === 'profile') {
    uploadOptions.transformation = [...CloudinaryTransformations.PROFILE];
  } else if (type === 'service') {
    uploadOptions.eager = [
      { transformation: [...CloudinaryTransformations.SERVICE_THUMBNAIL] },
      { transformation: [...CloudinaryTransformations.SERVICE_FULL] },
    ];
  }

  try {
    const result = await cloudinary.uploader.upload(uploadData, uploadOptions);
    return formatUploadResult(result);
  } catch (error: unknown) {
    console.error('Cloudinary upload error:', error);
    const message = (error as { message?: unknown } | null)?.message;
    throw new GraphQLError(
      typeof message === 'string' && message ? message : 'Failed to upload file',
      { extensions: { code: 'UPLOAD_FAILED' } }
    );
  }
};

/**
 * Whether a parsed asset lives in this backend's Cloudinary account
 */
const isOwnCloud = (asset: { cloudName: string }): boolean =>
  Boolean(config.cloudinary.cloudName) && asset.cloudName === config.cloudinary.cloudName;

/**
 * Delivery URL for an asset, without any URL signature
 */
const deliveryUrl = (asset: CloudinaryAsset): string => {
  const version = asset.version ? `v${asset.version}/` : '';
  const format = asset.format ? `.${asset.format}` : '';
  return `https://res.cloudinary.com/${asset.cloudName}/${asset.resourceType}/${asset.type}/${version}${asset.publicId}${format}`;
};

/**
 * Identify the asset behind a download link made by getDocumentViewUrl
 * (https://api.cloudinary.com/v1_1/{cloud}/{resource_type}/download?public_id=...)
 */
const parseDownloadUrl = (url: string): Omit<CloudinaryAsset, 'version' | 'format'> | null => {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    const [, apiVersion, cloudName, resourceType, action] = pathname.split('/');
    const publicId = searchParams.get('public_id');
    const type = searchParams.get('type');

    if (
      hostname !== 'api.cloudinary.com' ||
      apiVersion !== 'v1_1' ||
      action !== 'download' ||
      !cloudName ||
      !RESOURCE_TYPES.has(resourceType) ||
      !publicId ||
      !type
    ) {
      return null;
    }

    return { cloudName, resourceType: resourceType as CloudinaryAsset['resourceType'], type, publicId };
  } catch {
    return null;
  }
};

/**
 * What makes two document references the same file: a stored URL and a
 * download link for it compare equal
 */
const documentKey = (url: string): string => {
  const asset = parseCloudinaryUrl(url) ?? parseDownloadUrl(url);
  return asset ? [asset.cloudName, asset.resourceType, asset.type, asset.publicId].join('/') : url;
};

/**
 * The URL saved for an uploaded document: the plain delivery URL, without the
 * signature Cloudinary adds to authenticated URLs (that signature never expires)
 */
const storedDocumentUrl = (url: string): string => {
  const asset = parseCloudinaryUrl(url);
  return asset ? deliveryUrl(asset) : url;
};

/**
 * Flag a live (ACTIVE) listing whose images changed, the way updateService does
 */
const flagLiveListingImages = async (
  userId: string,
  service: { id: string; name: string; description: string; images: string[]; status: string },
  images: string[]
): Promise<void> => {
  if (service.status !== ServiceStatus.ACTIVE) return;

  await flagContent({
    targetType: 'SERVICE',
    targetId: service.id,
    targetUserId: userId,
    reason: 'OTHER',
    details: 'Automatic: live listing edited after approval',
    snapshot: {
      before: { name: service.name, description: service.description, images: service.images },
      after: { name: service.name, description: service.description, images },
    },
  });
};

// ==================
// URL Functions
// ==================

/**
 * Parse a Cloudinary delivery URL:
 * https://res.cloudinary.com/{cloud}/{resource_type}/{type}/[s--signature--/]v{version}/{public_id}[.{format}]
 * Raw files keep any extension in the public ID. Returns null for anything else.
 */
export const parseCloudinaryUrl = (url: string): CloudinaryAsset | null => {
  try {
    const { protocol, hostname, pathname } = new URL(url);
    if ((protocol !== 'https:' && protocol !== 'http:') || hostname !== 'res.cloudinary.com') {
      return null;
    }

    const [cloudName, resourceType, type, ...rest] = pathname
      .split('/')
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
    const versionAt = rest.findIndex((segment) => /^v\d+$/.test(segment));
    const path = rest.slice(versionAt + 1).join('/');

    if (!cloudName || !RESOURCE_TYPES.has(resourceType) || !type || versionAt === -1 || !path) {
      return null;
    }

    const asset = {
      cloudName,
      resourceType: resourceType as CloudinaryAsset['resourceType'],
      type,
      version: rest[versionAt].slice(1),
    };

    if (asset.resourceType === 'raw') {
      return { ...asset, publicId: path, format: null };
    }

    const withFormat = /^(.+)\.([a-z0-9]+)$/i.exec(path);
    return withFormat
      ? { ...asset, publicId: withFormat[1], format: withFormat[2].toLowerCase() }
      : { ...asset, publicId: path, format: null };
  } catch {
    return null;
  }
};

/**
 * The asset behind a Cloudinary URL, but only for files in this account that
 * `userId` uploaded (uploads are named `<folder>/<userId>_<...>`). Returns null
 * for anything else, so callers can never delete another user's file.
 */
export const extractOwnedAsset = (url: string, userId: string): CloudinaryAsset | null => {
  const asset = parseCloudinaryUrl(url);
  if (!asset || !isOwnCloud(asset)) return null;

  const fileName = asset.publicId.split('/').pop() ?? '';
  return fileName.startsWith(`${userId}_`) ? asset : null;
};

/**
 * Public ID of a file `userId` uploaded to this account, or null
 */
export const extractOwnedPublicId = (url: string, userId: string): string | null =>
  extractOwnedAsset(url, userId)?.publicId ?? null;

/**
 * Link through which a stored document can be opened. Authenticated and private
 * files in this account get a signed download link that expires after
 * DOCUMENT_LINK_TTL_SECONDS; public URLs are returned unchanged.
 */
export const getDocumentViewUrl = (documentUrl: string): string => {
  const asset = parseCloudinaryUrl(documentUrl);
  if (!asset || asset.type === 'upload' || !isOwnCloud(asset)) return documentUrl;

  try {
    return cloudinary.utils.private_download_url(asset.publicId, asset.format ?? '', {
      resource_type: asset.resourceType,
      type: asset.type,
      expires_at: Math.floor(Date.now() / 1000) + DOCUMENT_LINK_TTL_SECONDS,
    });
  } catch (error) {
    console.error('Failed to sign document link:', error);
    return documentUrl;
  }
};

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
): Promise<UploadResult> => sendToCloudinary(prepareFile(base64Data, type, filename), type, userId);

/**
 * Upload multiple files. Every file is checked before any is uploaded, and if an
 * upload fails the files already uploaded are deleted again.
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

  const prepared = files.map((file) => prepareFile(file.base64Data, type, file.filename));
  const results: UploadResult[] = [];

  try {
    for (const uploadData of prepared) {
      results.push(await sendToCloudinary(uploadData, type, userId));
    }
  } catch (error) {
    await discardUploads(results);
    throw error;
  }

  return results;
};

/**
 * Delete a file from Cloudinary. Pass the resource and delivery type the file
 * was stored with: a raw file (.doc, .docx) or an authenticated document is not
 * found under the default image/upload type.
 */
export const deleteFile = async (
  publicId: string,
  asset: Partial<DeletableAsset> = {}
): Promise<boolean> => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: asset.resourceType ?? 'image',
      type: asset.type ?? 'upload',
      invalidate: true,
    });
    return result.result === 'ok';
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    return false;
  }
};

/**
 * Delete the file behind a URL if `userId` uploaded it to this account.
 * Anything else is left alone.
 */
export const deleteOwnedFile = async (url: string, userId: string): Promise<boolean> => {
  const asset = extractOwnedAsset(url, userId);
  return asset ? deleteFile(asset.publicId, asset) : false;
};

/**
 * Delete files uploaded by a request that then failed
 */
export const discardUploads = async (results: UploadResult[]): Promise<void> => {
  await Promise.all(
    results.map((result) =>
      deleteFile(result.publicId, {
        resourceType: result.resourceType as DeletableAsset['resourceType'],
        type: result.type,
      })
    )
  );
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
 * Generate signed upload parameters for client-side upload.
 * Cloudinary checks the signature against every parameter sent with the upload
 * except file, api_key, cloud_name and resource_type, so every signed value is
 * returned and the client must send all of them.
 */
export const generateSignedUploadParams = (
  type: UploadType,
  userId: string
): SignedUploadParams => {
  const timestamp = Math.round(Date.now() / 1000);
  const folder = getFolderPath(type);
  const publicId = newPublicId(userId);
  const allowedFormats = ALLOWED_FORMATS[type].join(',');
  const deliveryType = getDeliveryType(type);
  // One set of parameters creates one file: a second upload with the same
  // public ID can't replace a file that has already been saved and reviewed
  const overwrite = false;

  const signature = cloudinary.utils.api_sign_request(
    {
      timestamp,
      folder,
      public_id: publicId,
      allowed_formats: allowedFormats,
      type: deliveryType,
      overwrite,
    },
    config.cloudinary.apiSecret
  );

  return {
    signature,
    timestamp,
    cloudName: config.cloudinary.cloudName,
    apiKey: config.cloudinary.apiKey,
    folder,
    publicId,
    allowedFormats,
    type: deliveryType,
    overwrite,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/${getResourceType(type)}/upload`,
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
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { profilePhoto: result.url },
    });
  } catch (error) {
    await discardUploads([result]);
    throw error;
  }

  // Delete the old photo if this user uploaded it
  if (user?.profilePhoto) {
    await deleteOwnedFile(user.profilePhoto, userId);
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

  await prisma.user.update({
    where: { id: userId },
    data: { profilePhoto: null },
  });

  await deleteOwnedFile(user.profilePhoto, userId);

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

  // Changing what customers see counts as posting
  await assertTermsAccepted(userId);

  // Check total image count
  const currentCount = service.images.length;
  if (currentCount + files.length > MAX_SERVICE_IMAGES) {
    throw new GraphQLError(
      `Maximum ${MAX_SERVICE_IMAGES} images allowed per service. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_IMAGES_EXCEEDED' } }
    );
  }

  // Upload images
  const results = await uploadMultipleFiles(files, 'service', userId, MAX_SERVICE_IMAGES);
  const newUrls = results.map((r) => r.url);
  const images = [...service.images, ...newUrls];

  // Update service with new images
  try {
    await prisma.service.update({
      where: { id: serviceId },
      data: { images },
    });
  } catch (error) {
    await discardUploads(results);
    throw error;
  }

  if (newUrls.length > 0) {
    await flagLiveListingImages(userId, service, images);
  }

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

  await assertTermsAccepted(userId);

  if (!service.images.includes(imageUrl)) {
    throw new GraphQLError('Image not found in service', {
      extensions: { code: 'IMAGE_NOT_FOUND' },
    });
  }

  const images = service.images.filter((img) => img !== imageUrl);

  await prisma.service.update({
    where: { id: serviceId },
    data: { images },
  });

  await flagLiveListingImages(userId, service, images);

  // Delete from Cloudinary (only files this provider uploaded)
  await deleteOwnedFile(imageUrl, userId);

  return true;
};

// ==================
// Provider Document Functions
// ==================

/**
 * Upload provider verification documents. They are stored as authenticated
 * files; the returned links expire (see getDocumentViewUrl).
 */
export const uploadProviderDocuments = async (
  userId: string,
  files: Array<{ base64Data: string; filename: string }>
): Promise<string[]> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw providerNotFound();
  }

  // Check total document count
  const currentCount = provider.documents.length;
  if (currentCount + files.length > MAX_PROVIDER_DOCUMENTS) {
    throw new GraphQLError(
      `Maximum ${MAX_PROVIDER_DOCUMENTS} documents allowed. You have ${currentCount} and are trying to add ${files.length}.`,
      { extensions: { code: 'MAX_DOCUMENTS_EXCEEDED' } }
    );
  }

  const results = await uploadMultipleFiles(files, 'document', userId, MAX_PROVIDER_DOCUMENTS);
  const newDocuments = results.map((r) => storedDocumentUrl(r.url));

  try {
    await prisma.serviceProvider.update({
      where: { userId },
      data: {
        documents: [...provider.documents, ...newDocuments],
      },
    });
  } catch (error) {
    await discardUploads(results);
    throw error;
  }

  return newDocuments.map(getDocumentViewUrl);
};

/**
 * Save documents uploaded straight to Cloudinary with getDocumentUploadParams.
 * Only authenticated files in this account's documents folder that this user
 * uploaded are accepted. Documents already saved are skipped.
 */
export const addProviderDocuments = async (
  userId: string,
  documentUrls: string[]
): Promise<string[]> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw providerNotFound();
  }

  const folderPrefix = `${CloudinaryFolders.DOCUMENTS}/${userId}_`;
  const knownKeys = new Set(provider.documents.map(documentKey));
  const newDocuments: string[] = [];

  for (const url of documentUrls) {
    const asset = url.length <= MAX_URL_LENGTH ? extractOwnedAsset(url, userId) : null;
    const inDocumentsFolder =
      asset?.publicId.startsWith(folderPrefix) === true &&
      !asset.publicId.slice(folderPrefix.length).includes('/');
    const allowedFile =
      asset?.resourceType === 'raw' ||
      (asset?.resourceType === 'image' && ALLOWED_FORMATS.document.includes(asset.format ?? ''));

    if (!asset || asset.type !== 'authenticated' || !inDocumentsFolder || !allowedFile) {
      throw new GraphQLError('Document URLs must be files you uploaded with getDocumentUploadParams', {
        extensions: { code: 'INVALID_DOCUMENT_URL' },
      });
    }

    const documentUrl = deliveryUrl(asset);
    const key = documentKey(documentUrl);
    if (!knownKeys.has(key)) {
      knownKeys.add(key);
      newDocuments.push(documentUrl);
    }
  }

  const currentCount = provider.documents.length;
  if (currentCount + newDocuments.length > MAX_PROVIDER_DOCUMENTS) {
    throw new GraphQLError(
      `Maximum ${MAX_PROVIDER_DOCUMENTS} documents allowed. You have ${currentCount} and are trying to add ${newDocuments.length}.`,
      { extensions: { code: 'MAX_DOCUMENTS_EXCEEDED' } }
    );
  }

  if (newDocuments.length > 0) {
    await prisma.serviceProvider.update({
      where: { userId },
      data: {
        documents: [...provider.documents, ...newDocuments],
      },
    });
  }

  return newDocuments.map(getDocumentViewUrl);
};

/**
 * Remove a provider document. Accepts the stored URL or a link returned for it
 * by the documents field.
 */
export const removeProviderDocument = async (
  userId: string,
  documentUrl: string
): Promise<boolean> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
  });

  if (!provider) {
    throw providerNotFound();
  }

  const key = documentKey(documentUrl);
  const stored = provider.documents.find((doc) => doc === documentUrl || documentKey(doc) === key);

  if (!stored) {
    throw new GraphQLError('Document not found', {
      extensions: { code: 'DOCUMENT_NOT_FOUND' },
    });
  }

  await prisma.serviceProvider.update({
    where: { userId },
    data: {
      documents: provider.documents.filter((doc) => doc !== stored),
    },
  });

  // Delete from Cloudinary (only files this provider uploaded)
  await deleteOwnedFile(stored, userId);

  return true;
};

// ==================
// Account Files
// ==================

// Files deleted at a time when an account's files are removed
const ACCOUNT_FILE_DELETE_BATCH = 10;

/**
 * URLs of the files saved on a user's records: profile photo, provider gallery
 * images, verification documents and service images. Best effort: logs and
 * returns an empty list if the records can't be read.
 */
export const getUserFileUrls = async (userId: string): Promise<string[]> => {
  try {
    const [user, provider] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { profilePhoto: true },
      }),
      prisma.serviceProvider.findUnique({
        where: { userId },
        select: { images: true, documents: true, services: { select: { images: true } } },
      }),
    ]);

    return [
      user?.profilePhoto,
      ...(provider?.images ?? []),
      ...(provider?.documents ?? []),
      ...(provider?.services ?? []).flatMap((service) => service.images ?? []),
    ].filter((url): url is string => Boolean(url));
  } catch (error) {
    console.error('Failed to list the files of a deleted account:', error);
    return [];
  }
};

/**
 * Delete the Cloudinary files behind a user's URLs, for example when the account
 * is deleted. Only files this user uploaded to this backend's Cloudinary account
 * are deleted, each with its own resource and delivery type (public or private).
 * Best effort: failures are logged, never thrown.
 */
export const deleteUserFiles = async (
  userId: string,
  urls: ReadonlyArray<string | null | undefined>
): Promise<void> => {
  try {
    const assets = new Map<string, CloudinaryAsset>();
    for (const url of urls) {
      const asset = url ? extractOwnedAsset(url, userId) : null;
      if (asset) assets.set(`${asset.resourceType}/${asset.type}/${asset.publicId}`, asset);
    }

    const pending = [...assets.values()];
    let failed = 0;

    for (let start = 0; start < pending.length; start += ACCOUNT_FILE_DELETE_BATCH) {
      const batch = pending.slice(start, start + ACCOUNT_FILE_DELETE_BATCH);
      const deleted = await Promise.all(batch.map((asset) => deleteFile(asset.publicId, asset)));
      failed += deleted.filter((ok) => !ok).length;
    }

    if (failed > 0) {
      console.error(`Could not delete ${failed} of ${pending.length} Cloudinary files for user ${userId}`);
    }
  } catch (error) {
    console.error('Failed to delete the files of a deleted account:', error);
  }
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
 * Read a number from an aggregateRaw result, which may use extended JSON
 */
const toCount = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const wrapped = value as Record<string, unknown>;
    const raw = wrapped.$numberInt ?? wrapped.$numberLong ?? wrapped.$numberDouble;
    return Number(raw) || 0;
  }
  return 0;
};

/**
 * Pipeline totalling the lengths of array fields across a collection
 */
const sumArrayLengths = (fields: string[]) => ({
  pipeline: [
    {
      $group: {
        _id: null,
        ...Object.fromEntries(
          fields.map((field) => [
            field,
            { $sum: { $cond: [{ $isArray: `$${field}` }, { $size: `$${field}` }, 0] } },
          ])
        ),
      },
    },
  ],
});

const firstRow = (result: unknown): Record<string, unknown> =>
  Array.isArray(result) && result[0] && typeof result[0] === 'object'
    ? (result[0] as Record<string, unknown>)
    : {};

/**
 * Get upload statistics for admin dashboard
 */
export const getUploadStats = async (): Promise<{
  totalProfiles: number;
  totalServiceImages: number;
  totalProviderImages: number;
  totalDocuments: number;
}> => {
  const [profileCount, serviceTotals, providerTotals] = await Promise.all([
    prisma.user.count({
      where: { AND: [{ profilePhoto: { not: null } }, { profilePhoto: { not: '' } }] },
    }),
    prisma.service.aggregateRaw(sumArrayLengths(['images'])),
    prisma.serviceProvider.aggregateRaw(sumArrayLengths(['images', 'documents'])),
  ]);

  const services = firstRow(serviceTotals);
  const providers = firstRow(providerTotals);

  return {
    totalProfiles: profileCount,
    totalServiceImages: toCount(services.images),
    totalProviderImages: toCount(providers.images),
    totalDocuments: toCount(providers.documents),
  };
};
