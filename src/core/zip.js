// A minimal ZIP writer.
//
// Written by hand because the app has no dependencies and this needs to do
// exactly one thing: put a set of already-compressed files (PDFs, PNGs, slide
// decks) into one archive an organizer can hand to an AV team.
//
// Entries are STORED, not deflated. The files going in are overwhelmingly
// already-compressed formats, where deflate costs CPU and saves a percent or
// two, and storing keeps this small enough to read in one sitting.
//
// Format: PKWARE APPNOTE, sections 4.3.7 (local file header), 4.3.12 (central
// directory), 4.3.16 (end of central directory).

import { crc32 } from './crc32.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/**
 * Build a ZIP from `[{ name, data }]`.
 *
 * Names may contain forward slashes to make folders. Duplicate names are
 * suffixed rather than silently overwriting each other, because two speakers
 * both sending `slides.pdf` is the normal case, not an edge one.
 */
export function buildZip(files) {
  const entries = [];
  const chunks = [];
  const used = new Set();
  let offset = 0;

  for (const file of files) {
    const name = uniqueName(sanitiseName(file.name), used);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const time = dosTime(file.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(time.time, 10);
    local.writeUInt16LE(time.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field

    chunks.push(local, nameBytes, data);
    entries.push({ name: nameBytes, crc, size: data.length, offset, time });
    offset += local.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(entry.time.time, 12);
    central.writeUInt16LE(entry.time.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.size, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk number
    central.writeUInt16LE(0, 36);        // internal attributes
    central.writeUInt32LE(0, 38);        // external attributes
    central.writeUInt32LE(entry.offset, 42);

    chunks.push(central, entry.name);
    offset += central.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);             // no archive comment
  chunks.push(end);

  return Buffer.concat(chunks);
}

/**
 * Make a name safe to write into an archive.
 *
 * Absolute paths and `..` segments come out: an archive that writes outside the
 * directory it is extracted into is the classic zip-slip, and we are producing
 * archives that other people will open.
 */
export function sanitiseName(name) {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[\u0000-\u001f:*?"<>|]/g, '').trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..');

  return parts.join('/').slice(0, 200) || 'file';
}

function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** MS-DOS date and time, which is what ZIP stores. Epoch is 1980. */
function dosTime(iso) {
  const when = iso ? new Date(iso) : new Date(0);
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
  };
}
