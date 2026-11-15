import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { ADS_CATALOG_REPOSITORY, type AdCatalogBlock, type AdsCatalogRepository } from "./ads-catalog.repository.js";
import { AdCatalogNotFoundError } from "./ads-errors.js";
import { AdsService } from "./ads.service.js";

/**
 * Архив рекламных блоков (docs/35-stage4-plan.md Р200, docs/29-admin-panel.md,
 * раздел «Реклама»). Удаления у блока нет: на него ссылаются показы. Отслужившему
 * блоку — «В архив»: он выключается и в панели виден только во вкладке «Архив»,
 * а воронка считается по сети и месту и архива не замечает. «Вернуть» снимает
 * отметку, но блок остаётся выключенным: включают его отдельно, в карточке.
 *
 * Право — `ads.edit`, как у остальных правок блока. Повтор («В архив» для
 * блока в архиве, «Вернуть» для блока вне архива) отвечает тем же блоком:
 * записи, аудита и сброса запаса блоков выдачи при этом нет.
 */

const DB_TIMEOUT_MS = 3_000;

@Injectable()
export class AdBlockArchiveService {
  private readonly logger = new Logger("ads");

  constructor(
    @Inject(ADS_CATALOG_REPOSITORY) private readonly repository: AdsCatalogRepository,
    private readonly roles: RolesService,
    private readonly ads: AdsService,
  ) {}

  /** Блок выключен и убран в архив одной записью. */
  async archive(actor: AccountRef, blockId: string, at = new Date()): Promise<AdCatalogBlock> {
    return await this.mark(actor, blockId, true, at);
  }

  /** Блок вернулся из архива выключенным. */
  async unarchive(actor: AccountRef, blockId: string, at = new Date()): Promise<AdCatalogBlock> {
    return await this.mark(actor, blockId, false, at);
  }

  private async mark(actor: AccountRef, blockId: string, archived: boolean, at: Date): Promise<AdCatalogBlock> {
    await this.roles.require(actor, "ads.edit");
    // «Было» для аудита берётся до записи: после неё прежнего состояния уже не видно.
    const before = (await this.db(this.repository.blocks())).find((candidate) => candidate.blockId === blockId);
    if (before === undefined) throw new AdCatalogNotFoundError("block");

    const result = await this.db(this.repository.setBlockArchived(blockId, archived, actor.accountId, at));
    if (result === null) throw new AdCatalogNotFoundError("block");
    if (!result.changed) return result.block;

    await this.roles.audit({ actorAccountId: actor.accountId, action: archived ? "ads.block.archive" : "ads.block.unarchive", target: blockId, before, after: result.block });
    // Правка видна выдаче сразу на этой реплике, на остальных — в пределах полуминуты.
    this.ads.forgetBlocks();
    this.logger.log(JSON.stringify({ module: "ads", event: archived ? "ad_block_archived" : "ad_block_unarchived", blockId, actor: actor.accountId }));
    return result.block;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "реклама");
  }
}
