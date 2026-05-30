export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export const ACCEPTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export function validateFileSize(fileSizeBytes, maxBytes = MAX_FILE_SIZE_BYTES) {
  return fileSizeBytes <= maxBytes;
}

export function extractExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

export function isAcceptedMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return false;
  return ACCEPTED_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isAcceptedExtension(filename) {
  return ACCEPTED_EXTENSIONS.has(extractExtension(filename));
}

export function isAcceptedImageFile(file) {
  if (!file) return false;
  return isAcceptedMimeType(file.type) || isAcceptedExtension(file.name);
}

export function generateUploadFileName(originalFilename) {
  const ext = extractExtension(originalFilename);
  const random = Math.random().toString(36).slice(2);
  return `${Date.now()}-${random}${ext ? '.' + ext : ''}`;
}

export function buildPublicUrl(supabaseUrl, bucket, fileName) {
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
}
