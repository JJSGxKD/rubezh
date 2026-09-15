import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { crc32, createDeflateRaw } from "node:zlib";

/**
 * Потоковый ZIP для выгрузки закрытого теста (docs/28-diagnostics.md §6.1.3):
 * файлы сжимаются на лету и пишутся на диск, архив «весь тест» не держится в
 * памяти.
 *
 * Своя реализация, а не библиотека: нужна одна операция — записать несколько
 * потоков в архив, — а живых и соразмерных библиотек для неё нет
 * (docs/16-tech-stack-decisions.md §0). Формат — PKZIP 2.0 с дескриптором
 * данных после каждого файла: размер сжатого потока заранее неизвестен.
 * ZIP64 не поддерживается — файл и архив до 4 ГБ, выгрузке закрытого теста
 * этого хватает с запасом, а превышение ловится явной ошибкой.
 */

const LIMIT_32 = 0xffff_ffff;
/** Бит 3 — размеры в дескрипторе после данных, бит 11 — имена в UTF-8. */
const FLAGS = 0x0808;
const DEFLATE = 8;
const VERSION = 20;

interface Entry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private readonly out: WriteStream;
  private readonly entries: Entry[] = [];
  private offset = 0;

  constructor(path: string) {
    this.out = createWriteStream(path);
  }

  /** Добавить файл из потока строк или буферов — например, NDJSON по страницам базы. */
  async addFile(name: string, source: AsyncIterable<string | Buffer>, modified = new Date()): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    const { time, date } = dosDateTime(modified);
    const entry: Entry = { name: nameBytes, crc: 0, compressedSize: 0, size: 0, offset: this.offset, time, date };

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // CRC и размеры — нулями: настоящие значения идут в дескрипторе после данных.
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([header, nameBytes]));

    const deflate = createDeflateRaw({ level: 6 });
    const drained = (async () => {
      for await (const chunk of deflate) {
        entry.compressedSize += (chunk as Buffer).length;
        await this.write(chunk as Buffer);
      }
    })();
    for await (const part of source) {
      const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : part;
      if (chunk.length === 0) continue;
      entry.crc = crc32(chunk, entry.crc);
      entry.size += chunk.length;
      if (!deflate.write(chunk)) await once(deflate, "drain");
    }
    deflate.end();
    await drained;

    if (entry.size >= LIMIT_32 || entry.compressedSize >= LIMIT_32) {
      throw new Error(`ZIP без ZIP64 не вмещает файл ${name} больше 4 ГБ`);
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    await this.write(descriptor);
    this.entries.push(entry);
  }

  /** Дописать оглавление и закрыть файл; возвращает размер архива в байтах. */
  async finish(): Promise<number> {
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(VERSION, 4);
      record.writeUInt16LE(VERSION, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(DEFLATE, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([record, entry.name]));
    }
    const directorySize = this.offset - directoryOffset;
    if (this.offset >= LIMIT_32 || this.entries.length > 0xffff) throw new Error("ZIP без ZIP64 не вмещает архив больше 4 ГБ");

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await this.write(end);

    this.out.end();
    await once(this.out, "finish");
    return this.offset;
  }

  private async write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }
}

/**
 * Разрезать файл на части не больше `partBytes`: Bot API принимает документы
 * до 50 МБ. Части — `.001`, `.002`…; исходный архив собирается склейкой:
 * `copy /b a.zip.001+a.zip.002 a.zip` в Windows, `cat a.zip.* > a.zip` в Linux.
 */
export async function splitFile(path: string, partBytes: number, outDir: string): Promise<string[]> {
  const size = (await stat(path)).size;
  if (size <= partBytes) return [path];
  await mkdir(outDir, { recursive: true });
  const parts: string[] = [];
  for (let start = 0, index = 1; start < size; start += partBytes, index++) {
    const partPath = join(outDir, `${basename(path)}.${String(index).padStart(3, "0")}`);
    const reader = createReadStream(path, { start, end: Math.min(size, start + partBytes) - 1 });
    const writer = createWriteStream(partPath);
    for await (const chunk of reader) {
      if (!writer.write(chunk as Buffer)) await once(writer, "drain");
    }
    writer.end();
    await once(writer, "finish");
    parts.push(partPath);
  }
  return parts;
}

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getUTCFullYear());
  return {
    time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate(),
  };
}
