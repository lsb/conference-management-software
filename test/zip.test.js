import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, sanitiseName } from '../src/core/zip.js';
import { crc32 } from '../src/core/crc32.js';

/** Write the archive somewhere real, so a real unzip can judge it. */
function writeZip(files) {
  const dir = mkdtempSync(join(tmpdir(), 'conf-zip-'));
  const path = join(dir, 'archive.zip');
  writeFileSync(path, buildZip(files));
  return path;
}

function unzip(args) {
  return execFileSync('unzip', args, { encoding: 'utf8' });
}

test('crc32 matches the standard check value', () => {
  // The check value every CRC-32 implementation is measured against.
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('a real unzip accepts the archive and finds no errors', () => {
  const path = writeZip([
    { name: 'slides.pdf', data: Buffer.from('%PDF-1.4 hello\n'), date: '2026-08-01T10:00:00Z' },
  ]);
  assert.match(unzip(['-t', path]), /No errors detected/);
});

test('contents round-trip byte for byte', () => {
  const payload = Buffer.from('%PDF-1.4 the actual deck\n\x00\x01\x02binary\xff');
  const path = writeZip([{ name: 'deck.pdf', data: payload, date: '2026-08-01T10:00:00Z' }]);

  const out = execFileSync('unzip', ['-p', path, 'deck.pdf']);
  assert.ok(Buffer.from(out).equals(payload));
});

test('folders come out as folders', () => {
  const path = writeZip([
    { name: 'Priya Raman/slides.pdf', data: Buffer.from('a'), date: '2026-08-01T10:00:00Z' },
    { name: 'Marcus Okafor/slides.pdf', data: Buffer.from('b'), date: '2026-08-02T10:00:00Z' },
  ]);
  const listing = unzip(['-l', path]);
  assert.match(listing, /Priya Raman\/slides\.pdf/);
  assert.match(listing, /Marcus Okafor\/slides\.pdf/);
});

test('two speakers both sending slides.pdf do not overwrite each other', () => {
  // The normal case, not an edge one.
  const path = writeZip([
    { name: 'slides.pdf', data: Buffer.from('first'), date: '2026-08-01T10:00:00Z' },
    { name: 'slides.pdf', data: Buffer.from('second'), date: '2026-08-02T10:00:00Z' },
  ]);

  const listing = unzip(['-l', path]);
  assert.match(listing, /slides\.pdf/);
  assert.match(listing, /slides \(2\)\.pdf/);
  assert.equal(execFileSync('unzip', ['-p', path, 'slides.pdf']).toString(), 'first');
  assert.equal(execFileSync('unzip', ['-p', path, 'slides (2).pdf']).toString(), 'second');
});

test('a name cannot escape the directory it is extracted into', () => {
  // Zip slip. We are producing archives other people open.
  assert.equal(sanitiseName('../../etc/passwd'), 'etc/passwd');
  assert.equal(sanitiseName('/etc/passwd'), 'etc/passwd');
  // A Windows path becomes a relative one: the drive letter survives as a
  // folder name, the colon does not.
  assert.equal(sanitiseName('C:\\Windows\\system32'), 'C/Windows/system32');
  assert.equal(sanitiseName('..'), 'file');
  assert.equal(sanitiseName(''), 'file');

  const path = writeZip([{ name: '../../escape.txt', data: Buffer.from('x'), date: '2026-08-01T10:00:00Z' }]);
  assert.doesNotMatch(unzip(['-l', path]), /\.\./);
});

test('timestamps survive into the archive', () => {
  const path = writeZip([
    { name: 'a.txt', data: Buffer.from('x'), date: '2026-08-01T10:00:00Z' },
  ]);
  assert.match(unzip(['-l', path]), /08-01-2026 10:00/);
});

test('many files produce one valid archive', () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    name: `speaker-${i}/deck.pdf`,
    data: Buffer.from(`%PDF-1.4 deck ${i}\n`),
    date: '2026-08-01T10:00:00Z',
  }));
  const path = writeZip(files);

  assert.match(unzip(['-t', path]), /No errors detected/);
  assert.match(unzip(['-l', path]), /60 files/);
});

test('a name with characters a filesystem dislikes is cleaned', () => {
  assert.equal(sanitiseName('report: draft?.pdf'), 'report draft.pdf');
  assert.equal(sanitiseName('a"b<c>d|e.txt'), 'abcde.txt');
});
