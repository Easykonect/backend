/**
 * A deleted account's Cloudinary files: which URLs are collected, and which
 * files are deleted and how
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    serviceProvider: { findUnique: jest.fn() },
  },
}));

jest.mock('@/config', () => ({
  config: { cloudinary: { cloudName: 'easykonnet', apiKey: 'key', apiSecret: 'secret' } },
}));

jest.mock('@/lib/cloudinary', () => ({
  __esModule: true,
  default: {
    uploader: { upload: jest.fn(), destroy: jest.fn() },
    utils: { private_download_url: jest.fn(), api_sign_request: jest.fn() },
    api: { delete_resources: jest.fn() },
  },
  CloudinaryFolders: {
    PROFILES: 'easykonect/profiles',
    SERVICES: 'easykonect/services',
    DOCUMENTS: 'easykonect/documents',
    EVIDENCE: 'easykonect/evidence',
  },
  CloudinaryTransformations: { PROFILE: [], SERVICE_THUMBNAIL: [], SERVICE_FULL: [] },
}));

jest.mock('@/services/report.service', () => ({ flagContent: jest.fn() }));
jest.mock('@/services/terms.service', () => ({ assertTermsAccepted: jest.fn() }));

import prisma from '@/lib/prisma';
import cloudinary from '@/lib/cloudinary';
import { deleteUserFiles, getUserFileUrls } from '@/services/upload.service';

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  serviceProvider: { findUnique: jest.Mock };
};
const destroy = cloudinary.uploader.destroy as unknown as jest.Mock;

const userId = '507f1f77bcf86cd799439011';
const otherUserId = '507f1f77bcf86cd799439022';

const cloudUrl = (path: string, cloud = 'easykonnet') => `https://res.cloudinary.com/${cloud}/${path}`;
const photo = cloudUrl(`image/upload/v1789218000/easykonect/profiles/${userId}_1789218000123.jpg`);
const galleryImage = cloudUrl(`image/upload/v1789218000/easykonect/services/${userId}_1789218000456_3fa91c.png`);
const privateDocument = cloudUrl(`image/authenticated/v1789218000/easykonect/documents/${userId}_1789218000345_9f8e7d.pdf`);
const publicWordDocument = cloudUrl(`raw/upload/v1789218000/easykonect/documents/${userId}_1789218000678.docx`);
const serviceImage = cloudUrl(`image/upload/v1789218000/easykonect/services/${userId}_1789218000901_c4d5e6.webp`);

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  destroy.mockResolvedValue({ result: 'ok' });
});

describe('getUserFileUrls', () => {
  it('collects the profile photo, gallery images, documents and service images', async () => {
    db.user.findUnique.mockResolvedValue({ profilePhoto: photo });
    db.serviceProvider.findUnique.mockResolvedValue({
      images: [galleryImage],
      documents: [privateDocument, publicWordDocument],
      services: [{ images: [serviceImage] }, { images: [] }],
    });

    await expect(getUserFileUrls(userId)).resolves.toEqual([
      photo,
      galleryImage,
      privateDocument,
      publicWordDocument,
      serviceImage,
    ]);
    expect(db.serviceProvider.findUnique).toHaveBeenCalledWith({
      where: { userId },
      select: { images: true, documents: true, services: { select: { images: true } } },
    });
  });

  it('returns nothing for a customer with no photo', async () => {
    db.user.findUnique.mockResolvedValue({ profilePhoto: null });
    db.serviceProvider.findUnique.mockResolvedValue(null);

    await expect(getUserFileUrls(userId)).resolves.toEqual([]);
  });

  it('logs and returns nothing if the records cannot be read', async () => {
    db.user.findUnique.mockRejectedValue(new Error('database unavailable'));
    db.serviceProvider.findUnique.mockResolvedValue(null);

    await expect(getUserFileUrls(userId)).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('deleteUserFiles', () => {
  it('deletes each file the user uploaded with its own resource and delivery type', async () => {
    await deleteUserFiles(userId, [photo, galleryImage, privateDocument, publicWordDocument, serviceImage]);

    expect(destroy).toHaveBeenCalledTimes(5);
    expect(destroy).toHaveBeenCalledWith(`easykonect/profiles/${userId}_1789218000123`, {
      resource_type: 'image',
      type: 'upload',
      invalidate: true,
    });
    expect(destroy).toHaveBeenCalledWith(`easykonect/documents/${userId}_1789218000345_9f8e7d`, {
      resource_type: 'image',
      type: 'authenticated',
      invalidate: true,
    });
    expect(destroy).toHaveBeenCalledWith(`easykonect/documents/${userId}_1789218000678.docx`, {
      resource_type: 'raw',
      type: 'upload',
      invalidate: true,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("skips other users' files, other Cloudinary accounts, external links, empty values and repeats", async () => {
    await deleteUserFiles(userId, [
      photo,
      photo,
      null,
      undefined,
      '',
      cloudUrl(`image/upload/v1/easykonect/services/${otherUserId}_1.jpg`),
      cloudUrl(`image/upload/v1/easykonect/profiles/${userId}_1.jpg`, 'someone-else'),
      'https://example.com/avatar.jpg',
    ]);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('deletes large sets of files at most 10 at a time', async () => {
    const urls = Array.from({ length: 25 }, (_, index) =>
      cloudUrl(`image/upload/v1/easykonect/services/${userId}_${index}.jpg`)
    );
    let inFlight = 0;
    let mostInFlight = 0;
    destroy.mockImplementation(async () => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { result: 'ok' };
    });

    await deleteUserFiles(userId, urls);

    expect(destroy).toHaveBeenCalledTimes(25);
    expect(mostInFlight).toBeLessThanOrEqual(10);
  });

  it('never throws, and logs the files it could not delete', async () => {
    destroy.mockRejectedValueOnce(new Error('Cloudinary unavailable')).mockResolvedValue({ result: 'not found' });

    await expect(deleteUserFiles(userId, [photo, galleryImage])).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(`Could not delete 2 of 2 Cloudinary files for user ${userId}`);
  });
});
