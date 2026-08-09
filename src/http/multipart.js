// multipart/form-data parsing.
//
// Written by hand because the app has no dependencies, and because file upload
// is the one place where a careless parser turns into a security problem. It
// handles what browsers actually send for a `<form enctype="multipart/form-data">`
// and refuses anything it does not understand rather than guessing.
//
// Deliberately NOT supported, because nothing we serve emits them and silently
// mishandling them is worse than refusing:
//   * nested multipart/mixed parts (removed from the HTML spec years ago)
//   * base64 or quoted-printable content-transfer-encoding

import { badRequest } from './router.js';

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

/**
 * Parse a multipart body into fields and files.
 *
 * Returns `{ fields, files }`, where `fields` maps a name to a string (or an
 * array when repeated) and `files` maps a name to `{ filename, contentType,
 * data }`.
 */
export function parseMultipart(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) {
    throw badRequest('multipart body has no boundary',
      'the content-type header must look like: multipart/form-data; boundary=----abc');
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};

  // Parts sit between delimiters. Anything before the first one is preamble and
  // anything after the closing `--` is epilogue; both are ignored, per RFC 2046.
  const positions = indexesOf(body, delimiter);
  if (positions.length === 0) {
    throw badRequest('multipart body contains no parts',
      'the boundary in the content-type header does not appear in the body');
  }

  for (let i = 0; i < positions.length - 1; i++) {
    let start = positions[i] + delimiter.length;

    // A closing delimiter ends in `--`; nothing follows it.
    if (body.slice(start, start + 2).toString() === '--') break;
    if (body.slice(start, start + 2).equals(CRLF)) start += 2;

    const end = positions[i + 1];
    const raw = body.slice(start, end);

    const split = raw.indexOf(DOUBLE_CRLF);
    if (split === -1) continue;   // a part with no header block is not usable

    const headers = parseHeaders(raw.slice(0, split).toString('utf8'));
    // Trailing CRLF belongs to the delimiter that follows, not to the content.
    let content = raw.slice(split + DOUBLE_CRLF.length);
    if (content.length >= 2 && content.slice(-2).equals(CRLF)) content = content.slice(0, -2);

    const disposition = headers['content-disposition'] ?? '';
    const name = valueOfParameter(disposition, 'name');
    if (!name) continue;

    const filename = valueOfParameter(disposition, 'filename');

    if (filename === null) {
      const value = content.toString('utf8');
      if (Object.hasOwn(fields, name)) {
        fields[name] = [].concat(fields[name], value);
      } else {
        fields[name] = value;
      }
      continue;
    }

    // An empty file input still sends a part, with no filename and no bytes.
    // That is "the user did not choose a file", not "the user uploaded nothing".
    if (filename === '' && content.length === 0) continue;

    files[name] = {
      filename: safeFilename(filename),
      contentType: (headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim(),
      data: content,
    };
  }

  return { fields, files };
}

function boundaryOf(contentType = '') {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2]).trim() : null;
}

function indexesOf(haystack, needle) {
  const found = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** Read `name="value"` or `name=value` out of a header. Returns null if absent. */
function valueOfParameter(header, parameter) {
  const match = new RegExp(`${parameter}=(?:"([^"]*)"|([^;]*))`, 'i').exec(header);
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim();
}

/**
 * Reduce a browser-supplied filename to something safe to show and to store.
 *
 * The name is display only -- files are stored under a content hash, never under
 * this -- but it still ends up in HTML, in a content-disposition header, and in
 * organizers' downloads folders. Path separators, traversal, and control
 * characters all come out.
 */
export function safeFilename(name) {
  const base = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f"]/g, '')   // control characters and quotes
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'upload';
}
