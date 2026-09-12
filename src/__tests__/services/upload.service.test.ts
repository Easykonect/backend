/**
 * Upload service: Cloudinary URL parsing and ownership checks, signed upload
 * parameters, and links to private documents
 */

import { createHash } from 'crypto';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/config', () => ({
  config: { cloudinary: { cloudName: 'easykonnet', apiKey: 'key', apiSecret: 'secret' } },
}));
// Not used by the functions tested here; the real modules connect to Redis on import
jest.mock('@/services/report.service', () => ({ flagContent: jest.fn() }));
jest.mock('@/services/terms.service', () => ({ assertTermsAccepted: jest.fn() }));

import {
  extractOwnedPublicId,
  generateSignedUploadParams,
  getDocumentViewUrl,
  parseCloudinaryUrl,
} from '@/services/upload.service';

const userId = '507f1f77bcf86cd799439011';
const otherUserId = '507f1f77bcf86cd799439022';

const urlFor = (cloud: string, publicId: string) =>
  `https://res.cloudinary.com/${cloud}/image/upload/v1710000000/${publicId}.jpg`;

describe('extractOwnedPublicId', () => {
  it('returns the public_id for a file the user uploaded to this account', () => {
    const publicId = `easykonect/profiles/${userId}_1710000000`;
    expect(extractOwnedPublicId(urlFor('easykonnet', publicId), userId)).toBe(publicId);
  });

  it("returns null for another user's file", () => {
    const url = urlFor('easykonnet', `easykonect/documents/${otherUserId}_1710000000`);
    expect(extractOwnedPublicId(url, userId)).toBeNull();
  });

  it('returns null for files in another Cloudinary account', () => {
    const url = urlFor('someone-else', `easykonect/profiles/${userId}_1710000000`);
    expect(extractOwnedPublicId(url, userId)).toBeNull();
  });

  it('returns null for non-Cloudinary and malformed URLs', () => {
    expect(
      extractOwnedPublicId(`https://evil.example/easykonnet/v1/easykonect/profiles/${userId}_1.jpg`, userId)
    ).toBeNull();
    expect(extractOwnedPublicId('not a url', userId)).toBeNull();
  });

  it('keeps the extension of raw files, which is part of their public_id', () => {
    const url = `https://res.cloudinary.com/easykonnet/raw/upload/v1710000000/easykonect/documents/${userId}_1710000000.docx`;
    expect(extractOwnedPublicId(url, userId)).toBe(`easykonect/documents/${userId}_1710000000.docx`);
  });
});

describe('parseCloudinaryUrl', () => {
  it('reads the resource type, delivery type, version, public_id and format', () => {
    expect(parseCloudinaryUrl(urlFor('easykonnet', `easykonect/profiles/${userId}_1`))).toEqual({
      cloudName: 'easykonnet',
      resourceType: 'image',
      type: 'upload',
      version: '1710000000',
      publicId: `easykonect/profiles/${userId}_1`,
      format: 'jpg',
    });
  });

  it('skips the signature Cloudinary adds to authenticated URLs', () => {
    const url = `https://res.cloudinary.com/easykonnet/image/authenticated/s--Xy12Ab34--/v1710000000/easykonect/documents/${userId}_1.pdf`;
    expect(parseCloudinaryUrl(url)).toMatchObject({
      resourceType: 'image',
      type: 'authenticated',
      publicId: `easykonect/documents/${userId}_1`,
      format: 'pdf',
    });
  });

  it('reads raw files with and without an extension', () => {
    const base = `https://res.cloudinary.com/easykonnet/raw/authenticated/v1710000000/easykonect/documents/${userId}_1`;
    expect(parseCloudinaryUrl(`${base}.docx`)).toMatchObject({ publicId: `easykonect/documents/${userId}_1.docx`, format: null });
    expect(parseCloudinaryUrl(base)).toMatchObject({ resourceType: 'raw', publicId: `easykonect/documents/${userId}_1` });
  });

  it.each([
    ['no version', `https://res.cloudinary.com/easykonnet/image/upload/easykonect/profiles/${userId}_1.jpg`],
    ['an unknown resource type', `https://res.cloudinary.com/easykonnet/files/upload/v1/easykonect/profiles/${userId}_1.jpg`],
    ['a look-alike host', `https://res.cloudinary.com.example.com/easykonnet/image/upload/v1/${userId}_1.jpg`],
    ['a download link', 'https://api.cloudinary.com/v1_1/easykonnet/image/download?public_id=x&type=authenticated'],
    ['not a URL', 'photo.jpg'],
  ])('returns null for %s', (_label, url) => {
    expect(parseCloudinaryUrl(url)).toBeNull();
  });
});

/**
 * The signature Cloudinary computes for a signed upload from the form fields it
 * receives: every field except file, api_key, cloud_name, resource_type and the
 * signature itself, sorted by name, joined as key=value with &, followed by the
 * API secret, hashed with SHA-1
 */
const cloudinarySignature = (fields: Record<string, string>, secret: string) => {
  const signed = Object.entries(fields)
    .filter(([key]) => !['file', 'api_key', 'cloud_name', 'resource_type', 'signature'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(signed + secret).digest('hex');
};

// The form fields the guide tells the app to send with the file
const formFields = (params: ReturnType<typeof generateSignedUploadParams>): Record<string, string> => ({
  api_key: params.apiKey,
  timestamp: String(params.timestamp),
  folder: params.folder,
  public_id: params.publicId,
  allowed_formats: params.allowedFormats,
  type: params.type,
  overwrite: String(params.overwrite),
  signature: params.signature,
});

describe('generateSignedUploadParams', () => {
  it.each([
    ['profile', 'easykonect/profiles', 'jpg,jpeg,png,webp', 'upload', 'image'],
    ['service', 'easykonect/services', 'jpg,jpeg,png,webp,gif', 'upload', 'image'],
    ['document', 'easykonect/documents', 'jpg,jpeg,png,pdf,doc,docx', 'authenticated', 'auto'],
    ['evidence', 'easykonect/evidence', 'jpg,jpeg,png,pdf,mp4,mov', 'upload', 'auto'],
  ] as const)(
    'returns every parameter the %s signature covers',
    (kind, folder, allowedFormats, type, resourceType) => {
      const params = generateSignedUploadParams(kind, userId);

      expect(params).toMatchObject({
        cloudName: 'easykonnet',
        apiKey: 'key',
        folder,
        allowedFormats,
        type,
        overwrite: false,
        uploadUrl: `https://api.cloudinary.com/v1_1/easykonnet/${resourceType}/upload`,
      });
      expect(params.publicId).toMatch(new RegExp(`^${userId}_\\d+_[0-9a-f]{6}$`));
      expect(Math.abs(params.timestamp - Date.now() / 1000)).toBeLessThan(5);
      // Cloudinary accepts the upload only if this matches
      expect(params.signature).toBe(cloudinarySignature(formFields(params), 'secret'));
    }
  );

  it('gives every request its own public ID', () => {
    const first = generateSignedUploadParams('service', userId);
    const second = generateSignedUploadParams('service', userId);
    expect(first.publicId).not.toBe(second.publicId);
  });

  it('names files so the ownership checks recognise the uploader', () => {
    const params = generateSignedUploadParams('service', userId);
    // The secure_url Cloudinary returns for that upload
    const url = `https://res.cloudinary.com/easykonnet/image/upload/v1710000000/${params.folder}/${params.publicId}.jpg`;
    expect(extractOwnedPublicId(url, userId)).toBe(`${params.folder}/${params.publicId}`);
    expect(extractOwnedPublicId(url, otherUserId)).toBeNull();
  });

  it('never returns the API secret', () => {
    expect(Object.values(generateSignedUploadParams('document', userId))).not.toContain('secret');
  });
});

describe('getDocumentViewUrl', () => {
  it('returns public URLs unchanged', () => {
    const url = `https://res.cloudinary.com/easykonnet/image/upload/v1710000000/easykonect/documents/${userId}_1.pdf`;
    expect(getDocumentViewUrl(url)).toBe(url);
  });

  it("returns other accounts' files and unrecognised URLs unchanged", () => {
    const foreign = `https://res.cloudinary.com/someone-else/image/authenticated/v1/easykonect/documents/${userId}_1.pdf`;
    expect(getDocumentViewUrl(foreign)).toBe(foreign);
    expect(getDocumentViewUrl('cac-certificate.pdf')).toBe('cac-certificate.pdf');
  });

  it('turns authenticated files into download links that expire after 30 minutes', () => {
    const now = Math.floor(Date.now() / 1000);
    const link = new URL(
      getDocumentViewUrl(`https://res.cloudinary.com/easykonnet/image/authenticated/v1710000000/easykonect/documents/${userId}_1.pdf`)
    );

    expect(`${link.origin}${link.pathname}`).toBe('https://api.cloudinary.com/v1_1/easykonnet/image/download');
    expect(link.searchParams.get('public_id')).toBe(`easykonect/documents/${userId}_1`);
    expect(link.searchParams.get('type')).toBe('authenticated');
    expect(Number(link.searchParams.get('expires_at')) - now).toBeGreaterThanOrEqual(30 * 60);
    expect(Number(link.searchParams.get('expires_at')) - now).toBeLessThanOrEqual(30 * 60 + 5);
  });
});
