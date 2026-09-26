import type { ClickInput, LinkInput, LinkRecord, LinksRepository, LinkStats } from "../../src/modules/links/links.repository.js";

/** Ссылки в памяти — для сервисов ссылок и шеринга; Prisma-реализацию проверяет интеграционный тест. */
export class MemoryLinks implements LinksRepository {
  readonly links = new Map<string, LinkRecord>();
  readonly clicks: ClickInput[] = [];

  async create(link: LinkInput): Promise<LinkRecord> {
    const record = { ...link, createdAt: new Date() };
    this.links.set(link.code, record);
    return record;
  }

  async byCode(code: string): Promise<LinkRecord | null> {
    return this.links.get(code) ?? null;
  }

  async recordClick(click: ClickInput): Promise<void> {
    this.clicks.push(click);
  }

  async list(): Promise<LinkStats[]> {
    return [...this.links.values()]
      .filter((link) => link.sharedBy === null)
      .map((link) => ({ ...link, clicks: this.clicks.filter((click) => click.linkCode === link.code).length, clicks30d: 0, launches: 0 }));
  }
}
