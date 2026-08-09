import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseMultipart, safeFilename } from '../src/http/multipart.js';
import { storeUpload, readStoredFile, sniffType, IMAGE_TYPES, MAX_UPLOAD_BYTES } from '../src/core/files.js';
import { newEvent, addPerson } from './helpers.js';

const BOUNDARY = '----testboundary';
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

/** Build a multipart body the way a browser would. */
function body(parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    const disposition = part.filename === undefined
      ? `form-data; name="${part.name}"`
      : `form-data; name="${part.name}"; filename="${part.filename}"`;
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`));
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data ?? ''));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** A real 1x1 PNG, so magic-byte checks have something honest to look at. */
function png() {
  const chunk = (type, data) => {
    const body_ = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body_) >>> 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, body_, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

// --- the parser ------------------------------------------------------------

test('plain fields are parsed', () => {
  const { fields, files } = parseMultipart(
    body([{ name: 'first_name', data: 'Ada' }, { name: 'last_name', data: 'Lovelace' }]), CT);
  assert.deepEqual(fields, { first_name: 'Ada', last_name: 'Lovelace' });
  assert.deepEqual(files, {});
});

test('a repeated field becomes an array', () => {
  const { fields } = parseMultipart(
    body([{ name: 'tags', data: 'a' }, { name: 'tags', data: 'b' }]), CT);
  assert.deepEqual(fields.tags, ['a', 'b']);
});

test('a file part carries its bytes intact', () => {
  const image = png();
  const { files } = parseMultipart(
    body([{ name: 'headshot', filename: 'me.png', type: 'image/png', data: image }]), CT);

  assert.equal(files.headshot.filename, 'me.png');
  assert.equal(files.headshot.contentType, 'image/png');
  assert.ok(files.headshot.data.equals(image), 'binary content is byte-identical');
});

test('binary content containing CRLF is not truncated', () => {
  // A naive parser that splits on \r\n loses everything after the first one.
  const data = Buffer.from([1, 2, 0x0d, 0x0a, 3, 4, 0x0d, 0x0a, 5]);
  const { files } = parseMultipart(
    body([{ name: 'f', filename: 'x.bin', type: 'application/octet-stream', data }]), CT);
  assert.ok(files.f.data.equals(data));
});

test('fields and files can be mixed in one body', () => {
  const { fields, files } = parseMultipart(body([
    { name: 'title', data: 'My talk' },
    { name: 'slides', filename: 'deck.pdf', type: 'application/pdf', data: '%PDF-1.4 stuff' },
  ]), CT);
  assert.equal(fields.title, 'My talk');
  assert.equal(files.slides.filename, 'deck.pdf');
});

test('an empty file input is not treated as an upload', () => {
  // Browsers send the part regardless; it means "no file chosen".
  const { files } = parseMultipart(
    body([{ name: 'headshot', filename: '', type: 'application/octet-stream', data: '' }]), CT);
  assert.deepEqual(files, {});
});

test('a quoted boundary in the content-type header is understood', () => {
  const { fields } = parseMultipart(body([{ name: 'a', data: '1' }]),
    `multipart/form-data; boundary="${BOUNDARY}"`);
  assert.equal(fields.a, '1');
});

test('a body with no boundary is refused with a usable message', () => {
  assert.throws(() => parseMultipart(Buffer.from('x'), 'multipart/form-data'),
    /boundary/);
});

test('a filename cannot escape into a path', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\me\\deck.pdf'), 'deck.pdf');
  assert.equal(safeFilename('..'), 'upload');
  assert.equal(safeFilename('.bashrc'), 'bashrc');
  assert.equal(safeFilename(''), 'upload');
  assert.equal(safeFilename('normal name.png'), 'normal name.png');
  assert.ok(safeFilename('a'.repeat(500)).length <= 120);
});

// --- the store -------------------------------------------------------------

function upload(overrides = {}) {
  return { filename: 'me.png', contentType: 'image/png', data: png(), ...overrides };
}

test('an upload is stored and reads back byte-identical', () => {
  const { db, event } = newEvent();
  const person = addPerson(db);
  const stored = storeUpload(db, { eventId: event.id, personId: person.id, upload: upload() });

  assert.equal(stored.content_type, 'image/png');
  assert.equal(stored.byte_size, png().length);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);

  const back = readStoredFile(db, stored.slug);
  assert.ok(back.data.equals(png()));
});

test('the same bytes uploaded twice are stored once', () => {
  const { db, event } = newEvent();
  const a = storeUpload(db, { eventId: event.id, upload: upload() });
  const b = storeUpload(db, { eventId: event.id, upload: upload({ filename: 'copy.png' }) });

  assert.equal(a.sha256, b.sha256);
  assert.equal(a.storage_path, b.storage_path, 'one copy on disk');
  assert.notEqual(a.slug, b.slug, 'but two records, each with its own name');
});

test('a type outside the allow-list is refused, and the hint lists what is allowed', () => {
  const { db, event } = newEvent();
  try {
    storeUpload(db, { eventId: event.id, upload: upload({ contentType: 'application/x-sh' }) });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /'application\/x-sh' files are not accepted/);
    assert.match(err.hint, /image\/png/, 'the hint names what would work');
  }
});

test('a file whose bytes contradict its declared type is refused', () => {
  // The whole point: an HTML file labelled image/png never reaches disk.
  const { db, event } = newEvent();
  assert.throws(
    () => storeUpload(db, {
      eventId: event.id,
      upload: upload({ data: Buffer.from('<script>alert(1)</script>') }),
    }),
    /does not look like image\/png/);
});

test('an accept list narrows what a particular field will take', () => {
  const { db, event } = newEvent();
  assert.throws(
    () => storeUpload(db, {
      eventId: event.id,
      upload: upload({ contentType: 'application/pdf', data: Buffer.from('%PDF-1.4') }),
      accept: IMAGE_TYPES,
    }),
    /must be one of: image\/jpeg/);
});

test('an oversized upload is refused before it is written', () => {
  const { db, event } = newEvent();
  const huge = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  assert.throws(() => storeUpload(db, { eventId: event.id, upload: upload({ data: huge }) }),
    /over the 25 MB limit/);
});

test('an empty upload is refused', () => {
  const { db, event } = newEvent();
  assert.throws(() => storeUpload(db, { eventId: event.id, upload: upload({ data: Buffer.alloc(0) }) }),
    /no file was uploaded/);
});

test('sniffType recognises the formats we accept', () => {
  assert.equal(sniffType(png()), 'image/png');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    'image/webp');
  assert.equal(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'application/zip');
  assert.equal(sniffType(Buffer.from('just some text')), null);
});

test('a pptx is accepted even though it sniffs as a zip', () => {
  const { db, event } = newEvent();
  const stored = storeUpload(db, {
    eventId: event.id,
    upload: {
      filename: 'deck.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]),
    },
  });
  assert.match(stored.content_type, /presentationml/);
});
