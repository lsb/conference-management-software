// CRC-32 (IEEE 802.3), which is what ZIP and PNG both use to check an entry.
//
// A table-driven implementation, built once on first use. Node has no CRC-32 in
// its standard library and this app has no dependencies, so here it is: twenty
// lines that have not changed since 1975.

let table = null;

function buildTable() {
  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    built[n] = c >>> 0;
  }
  return built;
}

/** The CRC-32 of a buffer, as an unsigned 32-bit number. */
export function crc32(buffer) {
  if (!table) table = buildTable();

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
