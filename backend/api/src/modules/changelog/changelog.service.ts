import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { ChangelogEntryNotFoundError } from "./changelog-errors.js";
import { ChangelogFanout } from "./changelog-fanout.js";
import { CHANGELOG_PAGE_DEFAULT, freshVersions, pageOf, releasePlatforms, visibleOn, type ChangelogPage, type PublishedEntry } from "./changelog-rules.js";
import { CHANGELOG_REPOSITORY, type ChangelogEntryInput, type ChangelogEntryRecord, type ChangelogReleaseRecord, type ChangelogRepository } from "./changelog.repository.js";

/**
 * Журнал обновлений (docs/35-stage4-plan.md Р61, WP31): игроку — строки его
 * площадки по версиям, панели — все строки с метками площадок, правка и
 * публикация версии.
 *
 * Опубликованное держится в памяти процесса `CACHE_MS`, как фича-флаги: журнал
 * спрашивают на каждом входе ради знака меню, а меняется он раз в релиз.
 * Правка из панели сбрасывает кеш своей реплики сразу, остальные догоняют за
 * это время.
 *
 * Публикация версии начинает раздачу уведомления `app_update` — её ведёт
 * `ChangelogFanout` пачками и под локом, а не этот запрос.
 */

const CACHE_MS = 30_000;
const DB_TIMEOUT_MS = 3_000;

export interface ChangelogSaveInput extends ChangelogEntryInput {
  /** есть — правка записи, нет — новая */
  entryId?: string;
}

export interface ChangelogAdminView {
  entries: ChangelogEntryRecord[];
  releases: ChangelogReleaseRecord[];
}

export interface PublishResult {
  /** сколько черновиков опубликовано */
  published: number;
  release: ChangelogReleaseRecord | null;
}

type Player = Pick<AccountRef, "accountId" | "platform">;

@Injectable()
export class ChangelogService {
  private cache: { at: number; entries: PublishedEntry[] } | null = null;

  constructor(
    @Inject(CHANGELOG_REPOSITORY) private readonly repository: ChangelogRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    private readonly roles: RolesService,
    private readonly fanout: ChangelogFanout,
  ) {}

  /** Журнал игрока: версии его площадки новыми сверху, по курсору. */
  async page(player: Player, cursor: string | null, limit = CHANGELOG_PAGE_DEFAULT, now = new Date()): Promise<ChangelogPage> {
    const [entries, seenAt] = await Promise.all([this.entries(now.getTime()), this.seenAt(player.accountId)]);
    return pageOf(entries, player.platform, { cursor, limit, seenAt });
  }

  /** Знак меню: сколько версий вышло после того, как игрок открывал журнал. */
  async badge(player: Player, now = new Date()): Promise<number> {
    const entries = await this.entries(now.getTime());
    // Пустой журнал площадки — ни одного запроса о самом игроке.
    if (!entries.some((entry) => visibleOn(entry, player.platform))) return 0;
    return freshVersions(entries, player.platform, await this.seenAt(player.accountId));
  }

  /**
   * Игрок открыл журнал — прочитано всё не новее `upTo`: это самая поздняя
   * публикация из ответа, который он видел. Версия, вышедшая, пока журнал был
   * открыт, останется новой. Время из будущего — не дальше часов сервера.
   */
  async markSeen(accountId: string, upTo: Date, now = new Date()): Promise<void> {
    const at = new Date(Math.min(upTo.getTime(), now.getTime()));
    await withTimeout(this.repository.markSeen(accountId, at), DB_TIMEOUT_MS, "журнал прочитан");
  }

  async list(actor: AccountRef): Promise<ChangelogAdminView> {
    await this.roles.require(actor, "changelog.edit");
    const [entries, releases] = await Promise.all([this.repository.all(), this.repository.releases()]);
    return { entries, releases };
  }

  /**
   * Завести или поправить строку. У опубликованной меняются только текст и
   * вид: версию и площадки игроки уже получили вместе с уведомлением, и
   * перенос строки в другую версию или на другую площадку прошёл бы мимо
   * раздачи. Для этого — новая строка.
   */
  async save(actor: AccountRef, input: ChangelogSaveInput, now = new Date()): Promise<ChangelogEntryRecord> {
    await this.roles.require(actor, "changelog.edit");
    const entry = { version: input.version, platforms: [...new Set(input.platforms)], kind: input.kind, text: input.text };
    if (input.entryId === undefined) {
      const created = await this.repository.create(randomUUID(), entry, actor.accountId, now);
      await this.roles.audit({ actorAccountId: actor.accountId, action: "changelog.create", target: created.entryId, after: snapshot(created) });
      return created;
    }

    const before = await this.repository.byId(input.entryId);
    if (before === null) throw new ChangelogEntryNotFoundError();
    if (before.publishedAt !== null && (before.version !== entry.version || !samePlatforms(before.platforms, entry.platforms))) {
      throw new ValidationError("У опубликованной строки меняются только текст и вид — для другой версии или площадок заведите новую");
    }
    const updated = await this.repository.update(input.entryId, entry, actor.accountId, now);
    if (updated === null) throw new ChangelogEntryNotFoundError();
    this.cache = null;
    await this.roles.audit({ actorAccountId: actor.accountId, action: "changelog.update", target: updated.entryId, before: snapshot(before), after: snapshot(updated) });
    return updated;
  }

  async remove(actor: AccountRef, entryId: string): Promise<{ removed: boolean }> {
    await this.roles.require(actor, "changelog.edit");
    const before = await this.repository.byId(entryId);
    const removed = await this.repository.remove(entryId);
    this.cache = null;
    if (removed && before !== null) await this.roles.audit({ actorAccountId: actor.accountId, action: "changelog.remove", target: entryId, before: snapshot(before), after: null });
    return { removed };
  }

  /**
   * Опубликовать черновики версии и начать раздачу `app_update` игрокам
   * площадок её строк. Повтор без новых черновиков ничего не меняет;
   * публикация новых строк раздаёт заново — тем, кто уведомление уже
   * получил, ключ события в ленте второго не даст.
   */
  async publish(actor: AccountRef, version: string, now = new Date()): Promise<PublishResult> {
    await this.roles.require(actor, "changelog.publish");
    const published = await this.repository.publish(version, now);
    this.cache = null;
    if (published === 0) {
      const release = (await this.repository.releases()).find((candidate) => candidate.version === version) ?? null;
      if (release === null) throw new ValidationError("У версии нет черновиков — публиковать нечего");
      return { published, release };
    }

    const lines = (await this.repository.published()).filter((entry) => entry.version === version);
    const platforms = releasePlatforms(lines, PLATFORM_IDS);
    await this.repository.startRelease(version, platforms, now);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "changelog.publish", target: version, after: { published, platforms } });
    this.fanout.kick();
    const release = (await this.repository.releases()).find((candidate) => candidate.version === version) ?? null;
    return { published, release };
  }

  private async entries(nowMs: number): Promise<PublishedEntry[]> {
    if (this.cache === null || nowMs - this.cache.at > CACHE_MS) {
      this.cache = { at: nowMs, entries: await withTimeout(this.repository.published(), DB_TIMEOUT_MS, "журнал обновлений") };
    }
    return this.cache.entries;
  }

  /**
   * С какого времени версии для игрока новые: когда он открывал журнал, а не
   * открывал никогда — когда завёл аккаунт. Новичку история игры — не
   * новость: знак загорится с первой версией после его прихода.
   */
  private async seenAt(accountId: string): Promise<Date> {
    const seen = await withTimeout(this.repository.seenAt(accountId), DB_TIMEOUT_MS, "журнал прочитан");
    if (seen !== null) return seen;
    const account = await withTimeout(this.accounts.byId(accountId), DB_TIMEOUT_MS, "аккаунт");
    return account?.createdAt ?? new Date(0);
  }
}

function samePlatforms(a: readonly PlatformId[], b: readonly PlatformId[]): boolean {
  return a.length === b.length && a.every((platform) => b.includes(platform));
}

function snapshot(entry: ChangelogEntryRecord): Record<string, unknown> {
  return { version: entry.version, platforms: entry.platforms, kind: entry.kind, text: entry.text, published: entry.publishedAt !== null };
}
