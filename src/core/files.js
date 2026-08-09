// Stored files: headshots, slides, signed agreements.
//
// Content-addressed. A file is written to `data/uploads/ab/cdef...` where the
// path is its SHA-256, so uploading the same headshot twice stores one copy, a
// corrupted transfer cannot overwrite a good file, and nothing a submitter types
// ever becomes a path on disk.
//
// The original filename is kept as a label only. It is what an organizer sees
// and downloads as; it never influences where bytes land.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now, uniqueSlug } from '../db.js';
import { badRequest } from '../http/router.js';

// This file is src/core/files.js, so the repository root is three levels up.
const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const UPLOAD_DIR = join(ROOT_DIR, 'data', 'uploads');

/** 25 MB. Slide decks are big; a conference laptop's disk is not infinite. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * What may be uploaded, and what it will be served as.
 *
 * An allow-list, not a deny-list. The value is the content-type we serve back,
 * which is deliberately not the one the browser claimed: a caller who uploads a
 * `.png` containing HTML must not have it served as HTML.
 */
export const ALLOWED_TYPES = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
  'application/pdf': 'application/pdf',
  'text/plain': 'text/plain',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation':
    'application/vnd.oasis.opendocument.presentation',
  'application/zip': 'application/zip',
};

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Identify a file by its leading bytes.
 *
 * Returns a content type, or null when the bytes are not one of the formats we
 * recognise. Only used to *contradict* a claimed type, never to widen it: the
 * allow-list still decides what may be stored.
 */
export function sniffType(data) {
  const startsWith = (...bytes) => bytes.every((b, i) => data[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  // RIFF....WEBP
  if (startsWith(0x52, 0x49, 0x46, 0x46) && data.slice(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // Zip container: also .pptx and .odp, which are zips underneath.
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) {
    return 'application/zip';
  }
  return null;
}

/** The zip-backed formats, which all sniff as application/zip. */
const ZIP_BACKED = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

/**
 * Store an uploaded file and record it.
 *
 * `upload` is what `parseMultipart` produced: `{ filename, contentType, data }`.
 * Returns the `file` row.
 */
export function storeUpload(db, { eventId = null, personId = null, upload, accept = null }) {
  if (!upload || upload.data.length === 0) {
    throw badRequest('no file was uploaded', 'choose a file before submitting the form');
  }
  if (upload.data.length > MAX_UPLOAD_BYTES) {
    throw badRequest(
      `that file is ${Math.round(upload.data.length / 1024 / 1024)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`,
      'compress it, or share a link instead');
  }

  const declared = upload.contentType;
  const served = ALLOWED_TYPES[declared];
  if (!served) {
    throw badRequest(`'${declared}' files are not accepted`,
      `accepted types: ${Object.keys(ALLOWED_TYPES).join(', ')}`);
  }
  if (accept && !accept.includes(declared)) {
    throw badRequest(`this upload must be one of: ${accept.join(', ')}`,
      `you sent '${declared}'`);
  }

  // The browser's claimed type is a hint from whoever is uploading. Check it
  // against the actual bytes, so an HTML file labelled image/png is refused at
  // the door rather than stored and relied on to be served harmlessly later.
  const sniffed = sniffType(upload.data);
  const consistent = sniffed === declared
    || (sniffed === 'application/zip' && ZIP_BACKED.has(declared))
    // text/plain has no signature; anything without one is allowed to be text.
    || (declared === 'text/plain' && sniffed === null);

  if (!consistent) {
    throw badRequest(
      `that file does not look like ${declared}`,
      sniffed
        ? `its contents look like ${sniffed}; upload it with the right type or convert it`
        : 'its contents match no format we accept',
    );
  }

  const sha256 = createHash('sha256').update(upload.data).digest('hex');
  const relative = join(sha256.slice(0, 2), sha256.slice(2));
  const absolute = join(UPLOAD_DIR, relative);

  // Content-addressed, so an identical re-upload is already on disk and writing
  // it again would be pointless work, not a conflict.
  if (!existsSync(absolute)) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, upload.data);
  }

  const slug = uniqueSlug(upload.filename.replace(/\.[^.]+$/, '') || 'file',
    (s) => db.prepare('SELECT 1 FROM file WHERE slug = ?').get(s));

  return db.prepare(
    `INSERT INTO file (slug, event_id, uploaded_by_person_id, filename, content_type,
                       byte_size, sha256, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(slug, eventId, personId, upload.filename, served,
    upload.data.length, sha256, relative, now());
}

/** Read a stored file back. Returns null if the row or the bytes are missing. */
export function readStoredFile(db, slug) {
  const file = db.prepare('SELECT * FROM file WHERE slug = ?').get(slug);
  if (!file) return null;

  const absolute = join(UPLOAD_DIR, file.storage_path);
  if (!existsSync(absolute)) return null;
  return { file, data: readFileSync(absolute) };
}

export function isImage(file) {
  return IMAGE_TYPES.includes(file?.content_type);
}
