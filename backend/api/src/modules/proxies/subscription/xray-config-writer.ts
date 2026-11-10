import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { proxyNodeSchema, type ProxyNode } from "@bh/proxy-kit";
import { z } from "zod";
import { SUBSCRIPTION_KEY_FORMAT } from "./subscription-rules.js";

/**
 * Запись конфига Xray в общий том (docs/35-stage4-plan.md Р101, tasks/T-0093).
 * Контейнер Xray сам следит за хешем файла и перезапускается; здесь — только
 * атомарная запись: временный файл рядом и `rename`, чтобы контейнер никогда
 * не прочёл наполовину записанный конфиг.
 *
 * Несколько подписок (Р192, tasks/T-0384): секретов узлов (UUID, пароль) в базе
 * нет и не будет, а обновление одной подписки не должно терять узлы остальных.
 * Поэтому узлы каждой подписки лежат отдельным файлом-частью в том же томе
 * (`<каталог конфига>/subscriptions/<ключ>.json`), а `config.json` собирается из
 * частей включённых подписок. Уровень доверия тот же, что у `config.json`: том
 * подключён только к API и Xray; Xray части не читает, поэтому права на них уже.
 */

/** Каталога тома нет: контейнер Xray не подключён (dev или compose без него). */
export class SidecarMissingError extends Error {
  constructor() {
    super("Контейнер Xray не подключён: конфиг некуда записать");
    this.name = "SidecarMissingError";
  }
}

/** Узлы одной подписки с их слотами: то, что подписка вносит в общий конфиг. */
export interface ConfigPart {
  version: 1;
  nodes: { node: ProxyNode; slot: number }[];
}

/** Часть читается с диска — это граница системы, поэтому схема, а не приведение типа. */
const configPartSchema = z.strictObject({
  version: z.literal(1),
  nodes: z.array(z.strictObject({ node: proxyNodeSchema, slot: z.number().int().min(0) })),
}) satisfies z.ZodType<ConfigPart>;

export interface ConfigWriter {
  /** есть ли куда писать: каталог тома существует */
  available(): Promise<boolean>;
  /** лежит ли уже файл конфига: без него Xray висит на «жду конфиг» */
  exists(): Promise<boolean>;
  /** нет каталога — `SidecarMissingError` */
  write(config: Record<string, unknown>): Promise<void>;
  /** часть подписки; нет каталога — `SidecarMissingError`; ключ не по формату — ошибка */
  writePart(key: string, part: ConfigPart): Promise<void>;
  /** нет файла или он не читается и не проходит схему — `null`: подписку обновят заново */
  readPart(key: string): Promise<ConfigPart | null>;
  /** файла нет — не ошибка */
  removePart(key: string): Promise<void>;
}

export const CONFIG_WRITER = Symbol("CONFIG_WRITER");

/**
 * Права 0644: файл читает другой пользователь контейнера (Xray), а тайну
 * держит сам том — он подключён только к API и Xray, порты не опубликованы.
 */
const FILE_MODE = 0o644;
/** Части несут секреты узлов, а читает их только API: файл — владельцу, каталог — владельцу. */
const PART_FILE_MODE = 0o600;
const PART_DIR_MODE = 0o700;
const PARTS_DIR = "subscriptions";

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
    await this.replace(this.path, `${JSON.stringify(config, null, 2)}\n`, FILE_MODE);
  }

  async writePart(key: string, part: ConfigPart): Promise<void> {
    const file = this.partPath(key);
    if (!(await this.available())) throw new SidecarMissingError();
    const dir = dirname(file);
    await mkdir(dir, { recursive: true, mode: PART_DIR_MODE });
    // umask процесса мог срезать права при создании каталога; каталог, созданный раньше, мог получить другие.
    await chmod(dir, PART_DIR_MODE);
    await this.replace(file, JSON.stringify(part), PART_FILE_MODE);
  }

  async readPart(key: string): Promise<ConfigPart | null> {
    const file = this.partPath(key);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // Нет файла или он не читается: для вызывающего это одно и то же — частью воспользоваться нельзя.
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = configPartSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async removePart(key: string): Promise<void> {
    try {
      await unlink(this.partPath(key));
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  /** Путь части. Ключ входит в имя файла, поэтому формат проверяется до обращения к диску: выйти из каталога частей нельзя. */
  private partPath(key: string): string {
    if (!SUBSCRIPTION_KEY_FORMAT.test(key)) throw new RangeError("Ключ подписки не по формату: файл-часть не создаётся");
    return join(dirname(this.path), PARTS_DIR, `${key}.json`);
  }

  /** Временный файл рядом и `rename`: читающий никогда не увидит наполовину записанный файл. */
  private async replace(target: string, content: string, mode: number): Promise<void> {
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, content, { mode });
      // umask процесса мог срезать права при создании файла.
      await chmod(temporary, mode);
      await rename(temporary, target);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
