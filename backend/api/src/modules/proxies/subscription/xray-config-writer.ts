import { randomBytes } from "node:crypto";
import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Запись конфига Xray в общий том (docs/35-stage4-plan.md Р101, tasks/T-0093).
 * Контейнер Xray сам следит за хешем файла и перезапускается; здесь — только
 * атомарная запись: временный файл рядом и `rename`, чтобы контейнер никогда
 * не прочёл наполовину записанный конфиг.
 */

/** Каталога тома нет: контейнер Xray не подключён (dev или compose без него). */
export class SidecarMissingError extends Error {
  constructor() {
    super("Контейнер Xray не подключён: конфиг некуда записать");
    this.name = "SidecarMissingError";
  }
}

export interface ConfigWriter {
  /** есть ли куда писать: каталог тома существует */
  available(): Promise<boolean>;
  /** лежит ли уже файл конфига: без него Xray висит на «жду конфиг» */
  exists(): Promise<boolean>;
  /** нет каталога — `SidecarMissingError` */
  write(config: Record<string, unknown>): Promise<void>;
}

export const CONFIG_WRITER = Symbol("CONFIG_WRITER");

/**
 * Права 0644: файл читает другой пользователь контейнера (Xray), а тайну
 * держит сам том — он подключён только к API и Xray, порты не опубликованы.
 */
const FILE_MODE = 0o644;

export class FileConfigWriter implements ConfigWriter {
  constructor(private readonly path: string) {}

  async available(): Promise<boolean> {
    try {
      return (await stat(dirname(this.path))).isDirectory();
    } catch {
      return false;
    }
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.path)).isFile();
    } catch {
      return false;
    }
  }

  async write(config: Record<string, unknown>): Promise<void> {
    if (!(await this.available())) throw new SidecarMissingError();
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE });
      // umask процесса мог срезать права при создании файла.
      await chmod(temporary, FILE_MODE);
      await rename(temporary, this.path);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
