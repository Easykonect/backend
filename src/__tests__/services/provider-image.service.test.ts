/**
 * Provider Image Service Tests
 * Tests for uploadProviderImages and removeProviderImage
 */

import { GraphQLError } from 'graphql';

// Mock prisma
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    serviceProvider: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

// Mock upload.service functions used internally
jest.mock('@/services/upload.service', () => ({
  uploadMultipleFiles: jest.fn(),
  deleteFile: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { uploadMultipleFiles, deleteFile } from '@/services/upload.service';
import { uploadProviderImages, removeProviderImage } from '@/services/provider-image.service';

// ==================
// Test Data
// ==================

const mockUserId = '507f1f77bcf86cd799439011';
const mockImageUrl = 'https://res.cloudinary.com/test/image/upload/v1/providers/img1.jpg';
const mockImageUrl2 = 'https://res.cloudinary.com/test/image/upload/v1/providers/img2.jpg';

const mockProvider = {
  id: '507f1f77bcf86cd799439012',
  userId: mockUserId,
  images: [mockImageUrl],
};

const mockProviderEmpty = {
  ...mockProvider,
  images: [],
};

const mockFiles = [
  { base64Data: 'data:image/jpeg;base64,abc123', filename: 'photo.jpg' },
  { base64Data: 'data:image/png;base64,def456', filename: 'photo2.png' },
];

const mockUploadResults = [
  { url: mockImageUrl2, publicId: 'providers/img2', format: 'jpg', bytes: 1024, resourceType: 'image' },
];

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockUploadMultipleFiles = uploadMultipleFiles as jest.Mock;
const mockDeleteFile = deleteFile as jest.Mock;

// ==================
// uploadProviderImages
// ==================

describe('uploadProviderImages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should upload images and update provider', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProviderEmpty);
    mockUploadMultipleFiles.mockResolvedValue(mockUploadResults);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({
      ...mockProviderEmpty,
      images: [mockImageUrl2],
    });

    const result = await uploadProviderImages(mockUserId, [mockFiles[0]]);

    expect(result).toEqual([mockImageUrl2]);
    expect(mockUploadMultipleFiles).toHaveBeenCalledWith(
      [mockFiles[0]],
      'service',
      mockUserId,
      10
    );
    expect(mockPrisma.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId: mockUserId },
      data: { images: [mockImageUrl2] },
    });
  });

  it('should append to existing images', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    mockUploadMultipleFiles.mockResolvedValue(mockUploadResults);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({
      ...mockProvider,
      images: [mockImageUrl, mockImageUrl2],
    });

    await uploadProviderImages(mockUserId, [mockFiles[0]]);

    expect(mockPrisma.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId: mockUserId },
      data: { images: [mockImageUrl, mockImageUrl2] },
    });
  });

  it('should throw NOT_FOUND if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(uploadProviderImages(mockUserId, mockFiles)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(mockUploadMultipleFiles).not.toHaveBeenCalled();
  });

  it('should throw MAX_IMAGES_EXCEEDED if over the 10 image limit', async () => {
    const providerWithNineImages = {
      ...mockProvider,
      images: Array(9).fill(mockImageUrl),
    };
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(providerWithNineImages);

    // Trying to add 2 more when already at 9 (total would be 11)
    await expect(uploadProviderImages(mockUserId, mockFiles)).rejects.toMatchObject({
      extensions: { code: 'MAX_IMAGES_EXCEEDED' },
    });
    expect(mockUploadMultipleFiles).not.toHaveBeenCalled();
  });

  it('should allow adding images up to the 10 image limit', async () => {
    const providerWithNineImages = {
      ...mockProvider,
      images: Array(9).fill(mockImageUrl),
    };
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(providerWithNineImages);
    mockUploadMultipleFiles.mockResolvedValue([mockUploadResults[0]]);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({});

    // Trying to add exactly 1 more (total = 10) should succeed
    const result = await uploadProviderImages(mockUserId, [mockFiles[0]]);
    expect(result).toEqual([mockImageUrl2]);
  });

  it('should throw GraphQLError on provider not found', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(uploadProviderImages(mockUserId, mockFiles)).rejects.toThrow(GraphQLError);
  });
});

// ==================
// removeProviderImage
// ==================

describe('removeProviderImage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should remove an image and delete from Cloudinary', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);
    mockDeleteFile.mockResolvedValue(true);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({
      ...mockProvider,
      images: [],
    });

    const result = await removeProviderImage(mockUserId, mockImageUrl);

    expect(result).toBe(true);
    expect(mockDeleteFile).toHaveBeenCalled();
    expect(mockPrisma.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId: mockUserId },
      data: { images: [] },
    });
  });

  it('should throw NOT_FOUND if provider does not exist', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(removeProviderImage(mockUserId, mockImageUrl)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('should throw IMAGE_NOT_FOUND if image is not in provider gallery', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);

    await expect(
      removeProviderImage(mockUserId, 'https://res.cloudinary.com/test/image/upload/v1/providers/nonexistent.jpg')
    ).rejects.toMatchObject({
      extensions: { code: 'IMAGE_NOT_FOUND' },
    });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('should not update provider if image is not found', async () => {
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(mockProvider);

    try {
      await removeProviderImage(mockUserId, 'https://other.com/image.jpg');
    } catch {
      // expected
    }

    expect(mockPrisma.serviceProvider.update).not.toHaveBeenCalled();
  });

  it('should skip Cloudinary delete if public_id cannot be extracted from URL', async () => {
    const providerWithBadUrl = {
      ...mockProvider,
      images: ['https://invalid-url-no-version.com/image.jpg'],
    };
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(providerWithBadUrl);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({});

    const result = await removeProviderImage(mockUserId, 'https://invalid-url-no-version.com/image.jpg');

    expect(result).toBe(true);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockPrisma.serviceProvider.update).toHaveBeenCalled();
  });

  it('should filter out only the removed image from the array', async () => {
    const providerWithTwo = {
      ...mockProvider,
      images: [mockImageUrl, mockImageUrl2],
    };
    (mockPrisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue(providerWithTwo);
    mockDeleteFile.mockResolvedValue(true);
    (mockPrisma.serviceProvider.update as jest.Mock).mockResolvedValue({});

    await removeProviderImage(mockUserId, mockImageUrl);

    expect(mockPrisma.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId: mockUserId },
      data: { images: [mockImageUrl2] },
    });
  });
});
