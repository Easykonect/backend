/**
 * Cloudinary Configuration
 * Handles cloud storage for images and documents
 */

import { v2 as cloudinary } from 'cloudinary';
import { config } from '@/config';

// Configure Cloudinary from centralized config
cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

export default cloudinary;

// Export types for upload options
export interface CloudinaryUploadOptions {
  folder: string;
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
  transformation?: object[];
  allowedFormats?: string[];
  maxFileSize?: number; // in bytes
}

// Predefined folder paths for organization
export const CloudinaryFolders = {
  PROFILES: 'easykonect/profiles',
  SERVICES: 'easykonect/services',
  DOCUMENTS: 'easykonect/documents',
  EVIDENCE: 'easykonect/evidence',
} as const;

// Default transformations for different upload types
export const CloudinaryTransformations = {
  PROFILE: [
    { width: 400, height: 400, crop: 'fill', gravity: 'face' },
    { quality: 'auto', fetch_format: 'auto' },
  ],
  SERVICE_THUMBNAIL: [
    { width: 600, height: 400, crop: 'fill' },
    { quality: 'auto', fetch_format: 'auto' },
  ],
  SERVICE_FULL: [
    { width: 1200, height: 800, crop: 'limit' },
    { quality: 'auto', fetch_format: 'auto' },
  ],
  DOCUMENT: [
    { quality: 'auto' },
  ],
} as const;
