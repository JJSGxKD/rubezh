import { Inject, Injectable } from "@nestjs/common";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import type { StoredBenchReport } from "./types/stored-bench-report";

/**
 * Хранилище отчётов испытаний.
 *
 * Пока это файлы на диске, а не таблица в Postgres — и это осознанно:
 * в репозитории ещё нет ни одной миграции, а заводить первую ради временного
 * инструмента недели 1 значит тащить его в схему продукта навсегда. Когда
 * отчёты понадобится держать вместе с остальными данными, меняется только
 * этот файл — ради этого слой репозитория и существует
 * (docs/15-engineering-standards.md §2.3).
 */
@Injectable()
export class BenchReportsRepository {
  private readonly directory: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.directory = resolve(config.bench.reportsDir);
  }

  /**
   * Записывает отчёт, если такого ещё нет. Возвращает false, если отчёт с
   * этим ключом уже сохранён.
   *
   * Флаг `wx` — атомарное «создать, если не существует» на уровне файловой
   * системы. Проверка «существует ли файл» отдельным вызовом дала бы гонку
   * между двумя параллельными отправками одного и того же отчёта.
   */
  async create(record: StoredBenchReport): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });

    try {
      await writeFile(this.pathFor(record.reportId), JSON.stringify(record, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch (error: unknown) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  async findAll(limit: number): Promise<StoredBenchReport[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error: unknown) {
      // Каталога ещё нет — это не ошибка, просто ни одного прогона не было.
      if (isNotFound(error)) return [];
      throw error;
    }

    const records: StoredBenchReport[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(join(this.directory, entry), "utf8");
      records.push(JSON.parse(raw) as StoredBenchReport);
    }

    return records
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  private pathFor(reportId: string): string {
    // reportId проверен схемой как UUID, но путь всё равно собирается из
    // белого списка символов: любая правка схемы не должна превращаться в
    // выход за пределы каталога.
    return join(this.directory, `${reportId.replace(/[^0-9a-fA-F-]/g, "")}.json`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error) && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return hasCode(error) && error.code === "ENOENT";
}

function hasCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
