import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_SIZE_BYTES,
  ACCEPTED_MIME_TYPES,
  ACCEPTED_EXTENSIONS,
  validateFileSize,
  extractExtension,
  isAcceptedMimeType,
  isAcceptedExtension,
  isAcceptedImageFile,
  generateUploadFileName,
  buildPublicUrl,
} from '../js/imageUpload.js';

// ── helpers ────────────────────────────────────────────────────────────

const makeFile = (name, type, size = 1024) => ({ name, type, size });

// ── MAX_FILE_SIZE_BYTES ────────────────────────────────────────────────

describe('MAX_FILE_SIZE_BYTES', () => {
  it('equals exactly 10 MB', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
});

// ── validateFileSize ───────────────────────────────────────────────────

describe('validateFileSize', () => {
  it('accepts a file exactly at the limit', () => {
    expect(validateFileSize(MAX_FILE_SIZE_BYTES)).toBe(true);
  });

  it('accepts a file well under the limit', () => {
    expect(validateFileSize(1024)).toBe(true);
  });

  it('accepts a 0-byte file', () => {
    expect(validateFileSize(0)).toBe(true);
  });

  it('rejects a file one byte over the limit', () => {
    expect(validateFileSize(MAX_FILE_SIZE_BYTES + 1)).toBe(false);
  });

  it('rejects a file significantly over the limit', () => {
    expect(validateFileSize(50 * 1024 * 1024)).toBe(false);
  });

  it('accepts a custom maxBytes parameter', () => {
    expect(validateFileSize(500, 1000)).toBe(true);
    expect(validateFileSize(1001, 1000)).toBe(false);
  });
});

// ── extractExtension ──────────────────────────────────────────────────

describe('extractExtension', () => {
  it('returns lowercase extension for jpg', () => {
    expect(extractExtension('photo.jpg')).toBe('jpg');
  });

  it('normalises JPEG to lowercase jpeg', () => {
    expect(extractExtension('photo.JPEG')).toBe('jpeg');
  });

  it('returns png', () => {
    expect(extractExtension('image.png')).toBe('png');
  });

  it('returns webp', () => {
    expect(extractExtension('banner.webp')).toBe('webp');
  });

  it('returns pdf for document.pdf', () => {
    expect(extractExtension('document.pdf')).toBe('pdf');
  });

  it('returns the last segment for filenames with multiple dots', () => {
    expect(extractExtension('my.photo.backup.jpg')).toBe('jpg');
  });

  it('returns empty string when there is no extension', () => {
    expect(extractExtension('noextension')).toBe('');
  });

  it('returns empty string for empty filename', () => {
    expect(extractExtension('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(extractExtension(null)).toBe('');
  });

  it('returns empty string for a trailing-dot filename', () => {
    expect(extractExtension('file.')).toBe('');
  });
});

// ── isAcceptedMimeType ────────────────────────────────────────────────

describe('isAcceptedMimeType', () => {
  it.each(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])(
    'accepts %s',
    (mime) => expect(isAcceptedMimeType(mime)).toBe(true),
  );

  it('is case-insensitive', () => {
    expect(isAcceptedMimeType('image/JPEG')).toBe(true);
    expect(isAcceptedMimeType('IMAGE/PNG')).toBe(true);
  });

  it('rejects image/gif', () => {
    expect(isAcceptedMimeType('image/gif')).toBe(false);
  });

  it('rejects application/pdf', () => {
    expect(isAcceptedMimeType('application/pdf')).toBe(false);
  });

  it('rejects application/octet-stream', () => {
    expect(isAcceptedMimeType('application/octet-stream')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAcceptedMimeType('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isAcceptedMimeType(null)).toBe(false);
  });
});

// ── isAcceptedExtension ───────────────────────────────────────────────

describe('isAcceptedExtension', () => {
  it.each(['photo.jpg', 'photo.jpeg', 'photo.png', 'photo.webp'])(
    'accepts %s',
    (filename) => expect(isAcceptedExtension(filename)).toBe(true),
  );

  it('is case-insensitive via extractExtension', () => {
    expect(isAcceptedExtension('photo.JPG')).toBe(true);
    expect(isAcceptedExtension('photo.PNG')).toBe(true);
  });

  it('rejects .pdf', () => {
    expect(isAcceptedExtension('document.pdf')).toBe(false);
  });

  it('rejects .exe', () => {
    expect(isAcceptedExtension('malware.exe')).toBe(false);
  });

  it('rejects .mp4', () => {
    expect(isAcceptedExtension('video.mp4')).toBe(false);
  });

  it('rejects a file with no extension', () => {
    expect(isAcceptedExtension('README')).toBe(false);
  });

  it('rejects .gif', () => {
    expect(isAcceptedExtension('anim.gif')).toBe(false);
  });
});

// ── isAcceptedImageFile ───────────────────────────────────────────────

describe('isAcceptedImageFile', () => {
  it('accepts a file with valid mime type', () => {
    expect(isAcceptedImageFile(makeFile('photo.jpg', 'image/jpeg'))).toBe(true);
  });

  it('accepts a file with valid extension even if mime is empty', () => {
    expect(isAcceptedImageFile(makeFile('photo.png', ''))).toBe(true);
  });

  it('accepts a file with valid mime even if extension is wrong', () => {
    expect(isAcceptedImageFile(makeFile('upload.tmp', 'image/webp'))).toBe(true);
  });

  it('rejects a PDF file', () => {
    expect(isAcceptedImageFile(makeFile('doc.pdf', 'application/pdf'))).toBe(false);
  });

  it('rejects an executable file', () => {
    expect(isAcceptedImageFile(makeFile('virus.exe', 'application/octet-stream'))).toBe(false);
  });

  it('rejects a GIF file', () => {
    expect(isAcceptedImageFile(makeFile('anim.gif', 'image/gif'))).toBe(false);
  });

  it('rejects null', () => {
    expect(isAcceptedImageFile(null)).toBe(false);
  });
});

// ── generateUploadFileName ────────────────────────────────────────────

describe('generateUploadFileName', () => {
  it('preserves the original extension', () => {
    const name = generateUploadFileName('photo.jpg');
    expect(name).toMatch(/\.jpg$/);
  });

  it('preserves webp extension', () => {
    expect(generateUploadFileName('banner.webp')).toMatch(/\.webp$/);
  });

  it('generates a non-empty filename for a file without extension', () => {
    const name = generateUploadFileName('README');
    expect(name.length).toBeGreaterThan(0);
    expect(name).not.toContain('.');
  });

  it('generates unique names for successive calls', () => {
    const names = new Set(Array.from({ length: 50 }, () => generateUploadFileName('photo.jpg')));
    expect(names.size).toBe(50);
  });

  it('does not contain the original filename in the output', () => {
    const name = generateUploadFileName('sensitive-info.jpg');
    expect(name).not.toContain('sensitive-info');
  });
});

// ── buildPublicUrl ────────────────────────────────────────────────────

describe('buildPublicUrl', () => {
  const BASE = 'https://eoladhcljbpbhnrmmpev.supabase.co';

  it('returns the correct public storage URL', () => {
    const url = buildPublicUrl(BASE, 'property-images', '12345-abc.jpg');
    expect(url).toBe(`${BASE}/storage/v1/object/public/property-images/12345-abc.jpg`);
  });

  it('includes the bucket name in the path', () => {
    const url = buildPublicUrl(BASE, 'avatars', 'user.png');
    expect(url).toContain('/avatars/');
  });

  it('includes the fileName at the end of the path', () => {
    const url = buildPublicUrl(BASE, 'property-images', 'my-file.webp');
    expect(url).toMatch(/my-file\.webp$/);
  });

  it('starts with the supabaseUrl', () => {
    const url = buildPublicUrl(BASE, 'property-images', 'file.png');
    expect(url.startsWith(BASE)).toBe(true);
  });
});
