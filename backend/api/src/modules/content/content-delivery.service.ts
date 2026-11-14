import { Inject, Injectable } from "@nestjs/common";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { CONTENT_PUBLISH_REPOSITORY, type ContentPublishRepository } from "./content-publish.repository.js";

/**
 * Выдача версии контента клиенту (docs/19-content-admin.md §3 и §5,
 * tasks/T-0306): какая версия у этого игрока и сам снимок по хэшу. Загрузку и
 * кеш на устройстве делает клиент (T-0307).
 */

/** Адрес снимка: хэш в имени — содержимое по нему не меняется, и кеш вечный. */
export const CONTENT_FILE_PREFIX = "/api/v1/content/v/";

export interface CurrentVersion {
  versionNo: number;
  hash: string;
  url: string;
}

/** Снимков в памяти: версий в игре одновременно две-три, а старые клиенты спрашивают прежнюю. */
const SNAPSHOT_CACHE_MAX = 8;

@Injectable()
export class ContentDeliveryService {
  /** хэш → снимок строкой: адрес неизменен, поэтому устаревать записи нечему */
  private readonly snapshots = new Map<string, string>();

  constructor(
    @Inject(CONTENT_PUBLISH_REPOSITORY) private readonly publications: ContentPublishRepository,
    private readonly roles: RolesService,
  ) {}

  /**
   * Версия для клиента со схемой `schema`: та, что в игре у его аудитории, а если
   * её форма новее клиента, — последняя из бывших в игре версий, которую клиент
   * понимает. `null` — публиковать нечего или понятной версии нет: клиент играет
   * встроенным контентом.
   *
   * Аудиторию берёт сервер: аккаунт с ролью — команда. Параметра в запросе нет,
   * иначе любой игрок получил бы версию, которую смотрит только команда.
   */
  async current(account: AccountRef, schema: number): Promise<CurrentVersion | null> {
    const pointers = await this.publications.pointers();
    let pointer = pointers.all;
    // Роли — лишний запрос на каждый вход: нужны, только когда у команды вообще другая версия.
    if (pointers.team !== null && pointers.team.versionNo !== pointers.all?.versionNo && (await this.roles.rolesFor(account)).length > 0) pointer = pointers.team;
    if (pointer === null) return null;
    const version = await this.publications.compatibleUpTo(pointer.versionNo, schema);
    return version === null ? null : { versionNo: version.versionNo, hash: version.contentHash, url: `${CONTENT_FILE_PREFIX}${version.contentHash}.json` };
  }

  /** Снимок, уже лежащий в памяти реплики: за ним в базу не ходят и лимит частоты не тратят. */
  peek(hash: string): string | undefined {
    return this.snapshots.get(hash);
  }

  /** Снимок версии, которая бывала в игре; остальные версии и черновики не отдаются. */
  async snapshot(hash: string): Promise<string | null> {
    const cached = this.snapshots.get(hash);
    if (cached !== undefined) return cached;
    const found = await this.publications.publishedSnapshot(hash);
    if (found === null) return null;
    const body = JSON.stringify(found.snapshot);
    if (this.snapshots.size >= SNAPSHOT_CACHE_MAX) this.snapshots.delete(this.snapshots.keys().next().value as string);
    this.snapshots.set(hash, body);
    return body;
  }
}
