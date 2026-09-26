import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError, UnavailableError } from "../../common/domain-error.js";
import { renderPng } from "../../common/card/svg.js";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RUNS_REPOSITORY, type RunsRepository } from "../runs/runs.repository.js";
import { newLinkCode } from "./link-code.js";
import { LINKS_REPOSITORY, type LinkRecord, type LinksRepository } from "./links.repository.js";
import { LinksService } from "./links.service.js";
import { formatSurvival, runCardKey, runCardSvg, type RunCardParams } from "./share-card.js";
import { SHARE_CARD_CACHE, type ShareCardCache } from "./share-card.cache.js";
import { SHARE_TEXTS } from "./share-texts.js";

/**
 * Шеринг результата забега (docs/24-attribution-and-sharing.md §7, WP16):
 * каждое «поделиться» — своя ссылка `/r/<код>` с тем, кто поделился и чем.
 * Так видно, что конвертит, накрученную ссылку можно погасить отдельно, а
 * приглашённого — встретить экраном этого забега.
 *
 * Поделиться можно только своим честным законченным забегом: картинку
 * увидят чужие люди, и забег с читами или отклонённый проверкой туда не идёт.
 *
 * Событий аналитики сервер не шлёт: `share_offered` и `share_completed` —
 * события клиента, а ссылка шеринга и её клики — строки `link` и `link_click`.
 */

export class ShareUnavailableError extends DomainError {
  constructor() {
    super("share_unavailable", "Этим забегом поделиться нельзя", 404);
  }
}

export interface ShareResult {
  code: string;
  url: string;
  imageUrl: string;
  /** подпись к ссылке — клиент подставит её в сообщение или историю */
  text: string;
}

export interface SharePreview {
  title: string;
  description: string;
  imageUrl: string | null;
}

@Injectable()
export class ShareService {
  private readonly logger = new Logger("links");

  constructor(
    @Inject(LINKS_REPOSITORY) private readonly links: LinksRepository,
    @Inject(RUNS_REPOSITORY) private readonly runs: Pick<RunsRepository, "summary">,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    @Inject(SHARE_CARD_CACHE) private readonly cache: ShareCardCache,
    private readonly linksService: LinksService,
  ) {}

  async shareRun(actor: AccessTokenClaims, runId: string): Promise<ShareResult> {
    const summary = await this.runs.summary(runId);
    if (summary === null || summary.accountId !== actor.accountId || summary.cheats || summary.verdict === "rejected") throw new ShareUnavailableError();

    const code = newLinkCode();
    const url = this.linksService.publicUrl(code);
    // Делиться можно только полным адресом: без домена клиента ссылку не отправить.
    if (url === null) throw new UnavailableError("Ссылки ещё не настроены — попробуйте позже");
    await this.links.create({
      code,
      platform: actor.platform,
      campaign: "share-run",
      source: "player",
      medium: null,
      note: null,
      createdBy: actor.accountId,
      sharedBy: actor.accountId,
      shareKind: "run",
      shareRef: runId,
    });
    this.logger.log(JSON.stringify({ module: "links", event: "share_created", kind: "run", accountId: actor.accountId, code }));
    return { code, url, imageUrl: `${url}/card.png`, text: SHARE_TEXTS.run.message(formatSurvival(summary.survivalSec)) };
  }

  /** PNG карточки ссылки шеринга; `null` — это не шеринг забега или забега уже нет. */
  async card(code: string): Promise<Buffer | null> {
    const link = await this.links.byCode(code);
    if (link === null) return null;
    const params = await this.paramsOf(link);
    if (params === null) return null;

    const key = runCardKey(params);
    const cached = await this.cache.get(key);
    if (cached !== null) return cached;
    const png = renderPng(runCardSvg(params));
    await this.cache.set(key, png);
    return png;
  }

  /** Заголовок, описание и картинка превью для краулера; `null` — ссылка не шеринг, превью общее. */
  async preview(link: LinkRecord): Promise<SharePreview | null> {
    const params = await this.paramsOf(link);
    if (params === null) return null;
    const url = this.linksService.publicUrl(link.code);
    return {
      title: SHARE_TEXTS.run.ogTitle(params.name, formatSurvival(params.survivalSec)),
      description: SHARE_TEXTS.run.ogDescription,
      imageUrl: url === null ? null : `${url}/card.png`,
    };
  }

  private async paramsOf(link: LinkRecord): Promise<RunCardParams | null> {
    if (link.shareKind !== "run" || link.shareRef === null || link.sharedBy === null) return null;
    const [summary, account] = await Promise.all([this.runs.summary(link.shareRef), this.accounts.byId(link.sharedBy)]);
    if (summary === null || account === null) return null;
    return { name: account.displayName, difficulty: summary.difficulty, survivalSec: Math.floor(summary.survivalSec), level: summary.level, kills: summary.enemiesKilled };
  }
}
