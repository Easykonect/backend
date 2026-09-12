/**
 * Upload service flows: multi-file cleanup, Cloudinary deletes with the right
 * resource type, moderation of service image changes, private provider
 * documents and upload statistics
 */

import { GraphQLError } from 'graphql';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    service: { findUnique: jest.fn(), update: jest.fn(), aggregateRaw: jest.fn() },
    serviceProvider: { findUnique: jest.fn(), update: jest.fn(), aggregateRaw: jest.fn() },
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
import { flagContent } from '@/services/report.service';
import { assertTermsAccepted } from '@/services/terms.service';
import {
  addProviderDocuments,
  deleteOwnedFile,
  getUploadStats,
  removeProviderDocument,
  removeServiceImage,
  uploadMultipleFiles,
  uploadProfilePhoto,
  uploadProviderDocuments,
  uploadServiceImages,
} from '@/services/upload.service';

const db = prisma as unknown as {
  user: Record<'findUnique' | 'update' | 'count', jest.Mock>;
  service: Record<'findUnique' | 'update' | 'aggregateRaw', jest.Mock>;
  serviceProvider: Record<'findUnique' | 'update' | 'aggregateRaw', jest.Mock>;
};
const upload = cloudinary.uploader.upload as unknown as jest.Mock;
const destroy = cloudinary.uploader.destroy as unknown as jest.Mock;
const privateDownloadUrl = cloudinary.utils.private_download_url as unknown as jest.Mock;
const mockFlagContent = flagContent as jest.Mock;
const mockAssertTerms = assertTermsAccepted as jest.Mock;

const userId = '507f1f77bcf86cd799439011';
const otherUserId = '507f1f77bcf86cd799439022';
const serviceId = '651b4c8d0e3f2a5b6c7d8e91';

const cloudUrl = (path: string, cloud = 'easykonnet') => `https://res.cloudinary.com/${cloud}/${path}`;
const documentId = (name: string) => `easykonect/documents/${userId}_${name}`;
const storedDocument = (name: string) => cloudUrl(`image/authenticated/v1789218000/${documentId(name)}.pdf`);
const jpeg = (name: string) => ({ base64Data: 'data:image/jpeg;base64,/9j/4AAQ', filename: `${name}.jpg` });
const pdf = (name: string) => ({ base64Data: 'JVBERi0xLjcK', filename: `${name}.pdf` });
const code = (value: string) => ({ extensions: { code: value } });

interface UploadCall {
  folder: string;
  public_id: string;
  type: string;
  resource_type: string;
}

// Cloudinary's reply to an upload, shaped by the options the service sent
const acceptUpload = async (_data: string, options: UploadCall) => {
  const resourceType = options.resource_type === 'auto' ? 'image' : options.resource_type;
  const format = options.folder.endsWith('documents') ? 'pdf' : 'jpg';
  // Cloudinary signs the delivery URL of authenticated files
  const signature = options.type === 'authenticated' ? 's--Xy12Ab34--/' : '';
  const publicId = `${options.folder}/${options.public_id}`;
  return {
    secure_url: cloudUrl(`${resourceType}/${options.type}/${signature}v1789218000/${publicId}.${format}`),
    public_id: publicId,
    format,
    resource_type: resourceType,
    type: options.type,
    bytes: 1024,
    width: 10,
    height: 10,
  };
};

const uploadedPublicIds = async (): Promise<string[]> =>
  Promise.all(upload.mock.results.map(async (result) => (await result.value).public_id));

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  upload.mockImplementation(acceptUpload);
  destroy.mockResolvedValue({ result: 'ok' });
  privateDownloadUrl.mockImplementation(
    (publicId: string, format: string, options: { resource_type: string; type: string }) =>
      `https://api.cloudinary.com/v1_1/easykonnet/${options.resource_type}/download?public_id=${publicId}&format=${format}&type=${options.type}&signature=abc`
  );
  mockAssertTerms.mockResolvedValue(undefined);
  mockFlagContent.mockResolvedValue(undefined);
});

// ==================
// Multi-file uploads
// ==================

describe('uploadMultipleFiles', () => {
  it('checks every file before uploading any of them', async () => {
    await expect(
      uploadMultipleFiles([jpeg('front'), { base64Data: 'AAAA', filename: 'notes.txt' }], 'service', userId)
    ).rejects.toMatchObject(code('INVALID_FILE_FORMAT'));

    expect(upload).not.toHaveBeenCalled();
  });

  it('deletes the files already uploaded when a later upload fails', async () => {
    upload
      .mockImplementationOnce(acceptUpload)
      .mockRejectedValueOnce({ message: 'Invalid image file', http_code: 400 });

    await expect(uploadMultipleFiles([jpeg('a'), jpeg('b')], 'service', userId)).rejects.toMatchObject({
      message: 'Invalid image file',
      extensions: { code: 'UPLOAD_FAILED' },
    });

    const firstPublicId = (await upload.mock.results[0].value).public_id;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(firstPublicId, { resource_type: 'image', type: 'upload', invalidate: true });
  });

  it('uploads verification documents as authenticated files named after the uploader', async () => {
    await uploadMultipleFiles([pdf('cac'), { base64Data: 'UEsDBBQ', filename: 'id.docx' }], 'document', userId);

    const idPattern = new RegExp(`^${userId}_\\d+_[0-9a-f]{6}$`);
    expect(upload).toHaveBeenNthCalledWith(1, 'data:application/pdf;base64,JVBERi0xLjcK', expect.objectContaining({
      folder: 'easykonect/documents',
      resource_type: 'auto',
      type: 'authenticated',
      public_id: expect.stringMatching(idPattern),
    }));
    expect(upload).toHaveBeenNthCalledWith(
      2,
      'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBBQ',
      expect.objectContaining({ type: 'authenticated' })
    );
  });

  it('gives every upload its own file name', async () => {
    await uploadMultipleFiles([jpeg('a'), jpeg('b'), jpeg('c')], 'service', userId);

    const names = upload.mock.calls.map(([, options]: [string, UploadCall]) => options.public_id);
    expect(new Set(names).size).toBe(3);
  });
});

// ==================
// Deleting files
// ==================

describe('deleteOwnedFile', () => {
  it('deletes a raw .docx under the raw resource type, keeping its extension in the ID', async () => {
    const url = cloudUrl(`raw/upload/v1789218000/easykonect/documents/${userId}_1789218000123.docx`);

    await expect(deleteOwnedFile(url, userId)).resolves.toBe(true);

    expect(destroy).toHaveBeenCalledWith(`easykonect/documents/${userId}_1789218000123.docx`, {
      resource_type: 'raw',
      type: 'upload',
      invalidate: true,
    });
  });

  it('deletes an authenticated PDF under its delivery type', async () => {
    const url = cloudUrl(`image/authenticated/s--Xy12Ab34--/v1789218000/${documentId('1789218000123_a1b2c3')}.pdf`);

    await deleteOwnedFile(url, userId);

    expect(destroy).toHaveBeenCalledWith(documentId('1789218000123_a1b2c3'), {
      resource_type: 'image',
      type: 'authenticated',
      invalidate: true,
    });
  });

  it("leaves other users' files and other accounts' files alone", async () => {
    await expect(
      deleteOwnedFile(cloudUrl(`image/upload/v1/easykonect/services/${otherUserId}_1.jpg`), userId)
    ).resolves.toBe(false);
    await expect(
      deleteOwnedFile(cloudUrl(`image/upload/v1/easykonect/services/${userId}_1.jpg`, 'someone-else'), userId)
    ).resolves.toBe(false);

    expect(destroy).not.toHaveBeenCalled();
  });
});

// ==================
// Service images
// ==================

describe('uploadServiceImages', () => {
  const existingImage = cloudUrl(`image/upload/v1/easykonect/services/${userId}_1.jpg`);
  const serviceRow = (status: string) => ({
    id: serviceId,
    name: 'Leaking Pipe Repair',
    description: 'Find and fix leaking pipes',
    status,
    images: [existingImage],
    provider: { userId },
  });

  it('checks ownership before the community terms', async () => {
    db.service.findUnique.mockResolvedValue({ ...serviceRow('ACTIVE'), provider: { userId: otherUserId } });

    await expect(uploadServiceImages(userId, serviceId, [jpeg('a')])).rejects.toMatchObject(code('FORBIDDEN'));
    expect(mockAssertTerms).not.toHaveBeenCalled();
  });

  it('requires the community terms before uploading anything', async () => {
    db.service.findUnique.mockResolvedValue(serviceRow('ACTIVE'));
    mockAssertTerms.mockRejectedValue(
      new GraphQLError('Please accept the community terms before posting', { extensions: { code: 'TERMS_NOT_ACCEPTED' } })
    );

    await expect(uploadServiceImages(userId, serviceId, [jpeg('a')])).rejects.toMatchObject(code('TERMS_NOT_ACCEPTED'));
    expect(mockAssertTerms).toHaveBeenCalledWith(userId);
    expect(upload).not.toHaveBeenCalled();
    expect(db.service.update).not.toHaveBeenCalled();
  });

  it('flags a live (ACTIVE) listing for admin review the way updateService does', async () => {
    db.service.findUnique.mockResolvedValue(serviceRow('ACTIVE'));
    db.service.update.mockResolvedValue({});

    const urls = await uploadServiceImages(userId, serviceId, [jpeg('a')]);

    expect(db.service.update).toHaveBeenCalledWith({ where: { id: serviceId }, data: { images: [existingImage, urls[0]] } });
    expect(mockFlagContent).toHaveBeenCalledWith({
      targetType: 'SERVICE',
      targetId: serviceId,
      targetUserId: userId,
      reason: 'OTHER',
      details: 'Automatic: live listing edited after approval',
      snapshot: {
        before: { name: 'Leaking Pipe Repair', description: 'Find and fix leaking pipes', images: [existingImage] },
        after: { name: 'Leaking Pipe Repair', description: 'Find and fix leaking pipes', images: [existingImage, urls[0]] },
      },
    });
  });

  it.each(['DRAFT', 'PENDING_APPROVAL', 'INACTIVE'])('does not flag a %s service', async (status) => {
    db.service.findUnique.mockResolvedValue(serviceRow(status));
    db.service.update.mockResolvedValue({});

    await uploadServiceImages(userId, serviceId, [jpeg('a')]);

    expect(mockFlagContent).not.toHaveBeenCalled();
  });

  it('deletes the uploaded images again if the service cannot be saved', async () => {
    db.service.findUnique.mockResolvedValue(serviceRow('ACTIVE'));
    db.service.update.mockRejectedValue(new Error('write conflict'));

    await expect(uploadServiceImages(userId, serviceId, [jpeg('a'), jpeg('b')])).rejects.toThrow('write conflict');

    const publicIds = await uploadedPublicIds();
    expect(destroy.mock.calls.map(([publicId]) => publicId).sort()).toEqual([...publicIds].sort());
    expect(mockFlagContent).not.toHaveBeenCalled();
  });
});

describe('removeServiceImage', () => {
  const ownedImage = cloudUrl(`image/upload/v1789218000/easykonect/services/${userId}_1789218000901.webp`);
  const externalImage = 'https://example.com/pipe.jpg';
  const serviceRow = {
    id: serviceId,
    name: 'Leaking Pipe Repair',
    description: 'Find and fix leaking pipes',
    status: 'ACTIVE',
    images: [ownedImage, externalImage],
    provider: { userId },
  };

  it('checks the terms, saves, flags the live listing, then deletes the file', async () => {
    db.service.findUnique.mockResolvedValue(serviceRow);
    db.service.update.mockResolvedValue({});

    await expect(removeServiceImage(userId, serviceId, ownedImage)).resolves.toBe(true);

    expect(mockAssertTerms).toHaveBeenCalledWith(userId);
    expect(db.service.update).toHaveBeenCalledWith({ where: { id: serviceId }, data: { images: [externalImage] } });
    expect(mockFlagContent).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'SERVICE',
      targetId: serviceId,
      snapshot: expect.objectContaining({ after: expect.objectContaining({ images: [externalImage] }) }),
    }));
    expect(destroy).toHaveBeenCalledWith(`easykonect/services/${userId}_1789218000901`, {
      resource_type: 'image',
      type: 'upload',
      invalidate: true,
    });
    expect(db.service.update.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);
  });

  it('changes nothing when the terms are not accepted', async () => {
    db.service.findUnique.mockResolvedValue(serviceRow);
    mockAssertTerms.mockRejectedValue(
      new GraphQLError('Please accept the community terms before posting', { extensions: { code: 'TERMS_NOT_ACCEPTED' } })
    );

    await expect(removeServiceImage(userId, serviceId, ownedImage)).rejects.toMatchObject(code('TERMS_NOT_ACCEPTED'));
    expect(db.service.update).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(mockFlagContent).not.toHaveBeenCalled();
  });
});

// ==================
// Provider documents
// ==================

describe('uploadProviderDocuments', () => {
  it('stores the unsigned authenticated URL and returns an expiring link', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [] });
    db.serviceProvider.update.mockResolvedValue({});

    const links = await uploadProviderDocuments(userId, [pdf('cac-certificate')]);

    const saved: string[] = db.serviceProvider.update.mock.calls[0][0].data.documents;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(
      new RegExp(`^https://res\\.cloudinary\\.com/easykonnet/image/authenticated/v1789218000/easykonect/documents/${userId}_\\d+_[0-9a-f]{6}\\.pdf$`)
    );

    const [publicId, format, options] = privateDownloadUrl.mock.calls[0];
    expect(`${publicId}`).toMatch(new RegExp(`^easykonect/documents/${userId}_`));
    expect(format).toBe('pdf');
    expect(options).toMatchObject({ resource_type: 'image', type: 'authenticated' });
    expect(Math.abs(options.expires_at - (Date.now() / 1000 + 30 * 60))).toBeLessThan(5);
    expect(links).toEqual([privateDownloadUrl.mock.results[0].value]);
  });

  it('returns PROVIDER_NOT_FOUND without a provider profile', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(null);

    await expect(uploadProviderDocuments(userId, [pdf('id')])).rejects.toMatchObject({
      message: 'Provider profile not found',
      extensions: { code: 'PROVIDER_NOT_FOUND' },
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses more than 5 documents in total before uploading', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({
      userId,
      documents: ['1', '2', '3', '4'].map((n) => storedDocument(n)),
    });

    await expect(uploadProviderDocuments(userId, [pdf('a'), pdf('b')])).rejects.toMatchObject({
      message: 'Maximum 5 documents allowed. You have 4 and are trying to add 2.',
      extensions: { code: 'MAX_DOCUMENTS_EXCEEDED' },
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('deletes the uploaded documents again if the profile cannot be saved', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [] });
    db.serviceProvider.update.mockRejectedValue(new Error('write conflict'));

    await expect(uploadProviderDocuments(userId, [pdf('cac')])).rejects.toThrow('write conflict');

    const [publicId] = await uploadedPublicIds();
    expect(destroy).toHaveBeenCalledWith(publicId, { resource_type: 'image', type: 'authenticated', invalidate: true });
  });
});

describe('addProviderDocuments', () => {
  const directUpload = (name: string) =>
    cloudUrl(`image/authenticated/s--Ab12Cd34--/v1789218000/${documentId(name)}.pdf`);

  it('saves an authenticated document the provider uploaded, without the URL signature', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [] });
    db.serviceProvider.update.mockResolvedValue({});

    const links = await addProviderDocuments(userId, [directUpload('1789218000123_a1b2c3')]);

    expect(db.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId },
      data: { documents: [storedDocument('1789218000123_a1b2c3')] },
    });
    expect(privateDownloadUrl).toHaveBeenCalledWith(documentId('1789218000123_a1b2c3'), 'pdf', expect.objectContaining({
      resource_type: 'image',
      type: 'authenticated',
    }));
    expect(links).toHaveLength(1);
  });

  it('accepts raw documents (.doc, .docx), whose URLs may have no extension', async () => {
    const raw = cloudUrl(`raw/authenticated/v1789218000/${documentId('1789218000123_a1b2c3')}`);
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [] });
    db.serviceProvider.update.mockResolvedValue({});

    await addProviderDocuments(userId, [raw]);

    expect(db.serviceProvider.update).toHaveBeenCalledWith({ where: { userId }, data: { documents: [raw] } });
    expect(privateDownloadUrl).toHaveBeenCalledWith(documentId('1789218000123_a1b2c3'), '', expect.objectContaining({
      resource_type: 'raw',
    }));
  });

  it.each([
    ['a public file', cloudUrl(`image/upload/v1/easykonect/documents/${userId}_1.pdf`)],
    ["another user's file", cloudUrl(`image/authenticated/v1/easykonect/documents/${otherUserId}_1.pdf`)],
    ['a file in another Cloudinary account', cloudUrl(`image/authenticated/v1/easykonect/documents/${userId}_1.pdf`, 'someone-else')],
    ['a file outside the documents folder', cloudUrl(`image/authenticated/v1/easykonect/services/${userId}_1.jpg`)],
    ['a file in a subfolder', cloudUrl(`image/authenticated/v1/easykonect/documents/extra/${userId}_1.pdf`)],
    ['an image format documents do not allow', cloudUrl(`image/authenticated/v1/easykonect/documents/${userId}_1.gif`)],
    ['a video', cloudUrl(`video/authenticated/v1/easykonect/documents/${userId}_1.mp4`)],
    ['a look-alike host', `https://res.cloudinary.com.example.com/easykonnet/image/authenticated/v1/easykonect/documents/${userId}_1.pdf`],
    ['not a URL', 'cac-certificate.pdf'],
  ])('rejects %s', async (_label, url) => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [] });

    await expect(addProviderDocuments(userId, [directUpload('1789218000123_a1b2c3'), url])).rejects.toMatchObject({
      message: 'Document URLs must be files you uploaded with getDocumentUploadParams',
      extensions: { code: 'INVALID_DOCUMENT_URL' },
    });
    expect(db.serviceProvider.update).not.toHaveBeenCalled();
  });

  it('skips documents already saved and repeats within the request', async () => {
    const saved = storedDocument('1789218000123_a1b2c3');
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [saved] });
    db.serviceProvider.update.mockResolvedValue({});

    const links = await addProviderDocuments(userId, [
      directUpload('1789218000123_a1b2c3'),
      directUpload('1789218000456_d4e5f6'),
      directUpload('1789218000456_d4e5f6'),
    ]);

    expect(db.serviceProvider.update).toHaveBeenCalledWith({
      where: { userId },
      data: { documents: [saved, storedDocument('1789218000456_d4e5f6')] },
    });
    expect(links).toHaveLength(1);
  });

  it('changes nothing when every document is already saved', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [storedDocument('1789218000123_a1b2c3')] });

    await expect(addProviderDocuments(userId, [directUpload('1789218000123_a1b2c3')])).resolves.toEqual([]);
    expect(db.serviceProvider.update).not.toHaveBeenCalled();
  });

  it('enforces the 5-document maximum', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({
      userId,
      documents: ['1', '2', '3', '4'].map((n) => storedDocument(n)),
    });

    await expect(addProviderDocuments(userId, [directUpload('5'), directUpload('6')])).rejects.toMatchObject({
      message: 'Maximum 5 documents allowed. You have 4 and are trying to add 2.',
      extensions: { code: 'MAX_DOCUMENTS_EXCEEDED' },
    });
    expect(db.serviceProvider.update).not.toHaveBeenCalled();
  });

  it('returns PROVIDER_NOT_FOUND without a provider profile', async () => {
    db.serviceProvider.findUnique.mockResolvedValue(null);

    await expect(addProviderDocuments(userId, [directUpload('1')])).rejects.toMatchObject(code('PROVIDER_NOT_FOUND'));
  });
});

describe('removeProviderDocument', () => {
  it('accepts the expiring link returned by the documents field', async () => {
    const saved = storedDocument('1789218000123_a1b2c3');
    const link = `https://api.cloudinary.com/v1_1/easykonnet/image/download?api_key=key&expires_at=1789219800&format=pdf&public_id=${documentId('1789218000123_a1b2c3')}&signature=abc&timestamp=1789218000&type=authenticated`;
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [saved] });
    db.serviceProvider.update.mockResolvedValue({});

    await expect(removeProviderDocument(userId, link)).resolves.toBe(true);

    expect(db.serviceProvider.update).toHaveBeenCalledWith({ where: { userId }, data: { documents: [] } });
    expect(destroy).toHaveBeenCalledWith(documentId('1789218000123_a1b2c3'), {
      resource_type: 'image',
      type: 'authenticated',
      invalidate: true,
    });
  });

  it('deletes an older public .docx as a raw file', async () => {
    const saved = cloudUrl(`raw/upload/v1789218000/easykonect/documents/${userId}_1789218000345.docx`);
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [saved] });
    db.serviceProvider.update.mockResolvedValue({});

    await removeProviderDocument(userId, saved);

    expect(destroy).toHaveBeenCalledWith(`easykonect/documents/${userId}_1789218000345.docx`, {
      resource_type: 'raw',
      type: 'upload',
      invalidate: true,
    });
  });

  it('returns DOCUMENT_NOT_FOUND for a document that is not on the profile', async () => {
    db.serviceProvider.findUnique.mockResolvedValue({ userId, documents: [storedDocument('1')] });

    await expect(removeProviderDocument(userId, storedDocument('2'))).rejects.toMatchObject(code('DOCUMENT_NOT_FOUND'));
    expect(db.serviceProvider.update).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

// ==================
// Profile photo
// ==================

describe('uploadProfilePhoto', () => {
  it('deletes the new photo and keeps the old one if the account cannot be saved', async () => {
    const oldPhoto = cloudUrl(`image/upload/v1/easykonect/profiles/${userId}_1.jpg`);
    db.user.findUnique.mockResolvedValue({ profilePhoto: oldPhoto });
    db.user.update.mockRejectedValue(new Error('database unavailable'));

    await expect(uploadProfilePhoto(userId, 'data:image/jpeg;base64,/9j/4AAQ', 'me.jpg')).rejects.toThrow('database unavailable');

    const [newPublicId] = await uploadedPublicIds();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(newPublicId, expect.anything());
  });
});

// ==================
// Upload statistics
// ==================

describe('getUploadStats', () => {
  it('totals the stored files with counts and aggregation, including gallery images', async () => {
    db.user.count.mockResolvedValue(5);
    db.service.aggregateRaw.mockResolvedValue([{ _id: null, images: 7 }]);
    db.serviceProvider.aggregateRaw.mockResolvedValue([{ _id: null, images: { $numberInt: '3' }, documents: { $numberLong: '2' } }]);

    await expect(getUploadStats()).resolves.toEqual({
      totalProfiles: 5,
      totalServiceImages: 7,
      totalProviderImages: 3,
      totalDocuments: 2,
    });

    expect(db.user.count).toHaveBeenCalledWith({
      where: { AND: [{ profilePhoto: { not: null } }, { profilePhoto: { not: '' } }] },
    });
    const providerGroup = db.serviceProvider.aggregateRaw.mock.calls[0][0].pipeline[0].$group;
    expect(Object.keys(providerGroup).sort()).toEqual(['_id', 'documents', 'images']);
    expect(db.service.aggregateRaw.mock.calls[0][0].pipeline[0].$group.images).toEqual({
      $sum: { $cond: [{ $isArray: '$images' }, { $size: '$images' }, 0] },
    });
  });

  it('returns zeros for empty collections', async () => {
    db.user.count.mockResolvedValue(0);
    db.service.aggregateRaw.mockResolvedValue([]);
    db.serviceProvider.aggregateRaw.mockResolvedValue([]);

    await expect(getUploadStats()).resolves.toEqual({
      totalProfiles: 0,
      totalServiceImages: 0,
      totalProviderImages: 0,
      totalDocuments: 0,
    });
  });
});
