/**
 * Cloudinary Integration Tests
 * Tests the Cloudinary connection and upload capabilities
 * 
 * Requires: CLOUDINARY_* env vars set in .env
 */

import cloudinary from '@/lib/cloudinary';
import { config } from '@/config';

describe('Cloudinary Integration', () => {
  // ==================
  // Configuration
  // ==================
  describe('Configuration', () => {
    it('should have Cloudinary credentials configured', () => {
      expect(config.cloudinary.cloudName).toBeTruthy();
      expect(config.cloudinary.apiKey).toBeTruthy();
      expect(config.cloudinary.apiSecret).toBeTruthy();
    });
  });

  // ==================
  // API Connection
  // ==================
  describe('API Connection', () => {
    it('should ping Cloudinary API successfully', async () => {
      const result = await cloudinary.api.ping();
      expect(result.status).toBe('ok');
    }, 15000);

    it('should fetch account usage info', async () => {
      const result = await cloudinary.api.usage();
      expect(result).toBeDefined();
      expect(result.credits).toBeDefined();
    }, 15000);
  });

  // ==================
  // Upload & Delete
  // ==================
  describe('Upload & Delete', () => {
    let uploadedPublicId: string;

    it('should upload a test image from URL', async () => {
      const result = await cloudinary.uploader.upload(
        'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        {
          folder: 'easykonect/tests',
          public_id: `test_upload_${Date.now()}`,
          overwrite: true,
        }
      );

      expect(result.secure_url).toBeDefined();
      expect(result.public_id).toContain('easykonect/tests');
      expect(result.resource_type).toBe('image');
      uploadedPublicId = result.public_id;
    }, 20000);

    it('should delete the uploaded test image', async () => {
      if (!uploadedPublicId) return;
      const result = await cloudinary.uploader.destroy(uploadedPublicId);
      expect(result.result).toBe('ok');
    }, 15000);
  });

  // ==================
  // Signed URL Generation
  // ==================
  describe('Signed URL Generation', () => {
    it('should generate a valid signed upload URL', () => {
      const timestamp = Math.round(Date.now() / 1000);
      const paramsToSign = { timestamp, folder: 'easykonect/test' };

      const signature = cloudinary.utils.api_sign_request(
        paramsToSign,
        config.cloudinary.apiSecret
      );

      expect(typeof signature).toBe('string');
      expect(signature).toHaveLength(40); // SHA-1 hex is 40 chars
    });
  });
});
