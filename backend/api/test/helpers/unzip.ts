import { inflateRawSync, crc32 } from "node:zlib";

/**
 * Разбор ZIP для тестов: оглавление с конца файла, каждый файл — inflate и
 * сверка CRC. Независимо от писателя: если писатель ошибётся в смещениях или
 * контрольных суммах, чтение упадёт.
 */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("нет конца оглавления");
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const files = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("битая запись оглавления");
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`битый локальный заголовок ${name}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize));
    if (data.length !== size) throw new Error(`размер ${name} не сошёлся`);
    if (crc32(data) !== expectedCrc) throw new Error(`CRC ${name} не сошёлся`);
    files.set(name, data);
  }
  return files;
}
