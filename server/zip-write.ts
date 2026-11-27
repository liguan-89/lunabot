// A tiny ZIP writer: local headers, a central directory and its end record, nothing else. Writes straight to a file
// so an export never holds more than one entry in memory. Store method for binary payloads (already-compressed media
// does not deflate), deflate for text.
import { closeSync, openSync, writeSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipWriteEntry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
}

export function zipEntryBytes(entry: ZipWriteEntry): { stored: Buffer; crc: number; uncompressed: number; method: 0 | 8 } {
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
  const method = entry.method ?? (entry.name.endsWith(".json") || entry.name.endsWith(".md") || entry.name.endsWith(".txt") ? 8 : 0);
  const stored = method === 8 ? deflateRawSync(data) : data;
  return { stored, crc: crc32(data), uncompressed: data.length, method };
}

/** Writes `entries` as a zip at `path`. Returns the entry count. Throws (leaving a partial file) on any write error. */
export function writeZipFile(path: string, entries: Iterable<ZipWriteEntry>): number {
  const fd = openSync(path, "w");
  try {
    let offset = 0;
    const centrals: Buffer[] = [];
    let count = 0;
    const put = (buf: Buffer) => {
      writeSync(fd, buf);
      offset += buf.length;
    };
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const { stored, crc, uncompressed, method } = zipEntryBytes(entry);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(stored.length, 18);
      local.writeUInt32LE(uncompressed, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const localOffset = offset;
      put(local);
      put(name);
      put(stored);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(stored.length, 20);
      central.writeUInt32LE(uncompressed, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(localOffset, 42);
      centrals.push(central, name);
      count += 1;
    }
    const centralStart = offset;
    for (const buf of centrals) put(buf);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    put(end);
    return count;
  } finally {
    closeSync(fd);
  }
}
