// ─────────────────────────────────────────────────────────────────────────────
// Minimal ZIP reader for GitHub Actions artifact archives.
//
// Not a general-purpose zip library — GitHub always packs artifacts with method 0
// (stored) or 8 (deflate), no encryption, no zip64. That's the only shape this
// reads. Avoids adding a zip dependency to a project that is deliberately
// dependency-free (see cli.ts): Node's zlib already does raw deflate, so all that's
// missing is parsing the End-of-Central-Directory + Central Directory records to
// find each entry's offset — a few dozen lines, not a library's worth.
// ─────────────────────────────────────────────────────────────────────────────

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/** Extract all file entries (directories skipped) from a zip buffer. */
export function readZip(buf: Buffer): ZipEntry[] {
  const minEocd = Math.max(0, buf.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid zip: End-of-Central-Directory not found');

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');

  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) throw new Error('Corrupt central directory record');
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('/')) {
      const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      entries.push({ name, data });
    }
  }
  return entries;
}
