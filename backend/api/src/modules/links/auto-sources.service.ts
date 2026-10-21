import { Inject, Injectable, Logger } from "@nestjs/common";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { parseStartParam } from "../attribution/start-param.js";
import { parsePairs } from "../attribution/start-param-pairs.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { AUTO_SOURCES_REPOSITORY, type AutoSourceOutcome, type AutoSourcesRepository } from "./auto-sources.repository.js";

/**
 * Автоисточники по ссылкам с метками (Р116, docs/24-attribution-and-sharing.md §3.6): первый
 * игрок, пришедший по `src-tgads_cmp-oct`, заводит источник сам — без захода в панель. Сессии
 * приходят одним путём и из Mini App, и из бота (`SessionRecorder`), поэтому и источник заводится
 * в одном месте.
 *
 * Значения пар в лог не пишутся: их вписывает кто угодно, а ссылки с метками видны всем. В лог
 * идёт только исход.
 */

/** Кампания источника, когда в параметре нет `cmp`: у ссылки кампания обязательна. */
const DEFAULT_CAMPAIGN = "auto";

export interface TaggedSession {
  /** сырая строка параметра запуска, как её записала сессия */
  startParam: string | null;
  platform: string;
  /** момент запуска, ISO: от него считается окно потолка и «последний раз» ключа */
  startedAt: string;
}

function platformOf(value: string): PlatformId {
  return PLATFORM_IDS.find((platform) => platform === value) ?? "telegram";
}

@Injectable()
export class AutoSourcesService {
  private readonly logger = new Logger("links");

  constructor(
    @Inject(AUTO_SOURCES_REPOSITORY) private readonly repository: AutoSourcesRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  /**
   * Разобрать параметр записанной сессии: известные пары — завести источник (если можно),
   * незнакомые ключи — в сводку. Разбор чистый, а в задании очереди лежит только сырая строка, поэтому
   * разбирается заново. Исход создания; `null` — в сессии нет пар с известными ключами.
   */
  async onSession(session: TaggedSession): Promise<AutoSourceOutcome | null> {
    const parsed = parseStartParam(session.startParam);
    const now = new Date(session.startedAt);

    let outcome: AutoSourceOutcome | null = null;
    const pairs = parsed.kind === "tagged" && parsed.raw !== null ? parsePairs(parsed.raw) : null;
    if (pairs !== null && pairs.canonical !== null) {
      // src — источник, cmp — кампания, plc — место размещения; prt — только метка партнёра:
      // ни привязки к его карточке, ни начислений.
      outcome = await this.repository.ensure({
        autoKey: pairs.canonical,
        source: pairs.known.src ?? null,
        campaign: pairs.known.cmp ?? DEFAULT_CAMPAIGN,
        medium: pairs.known.plc ?? null,
        partnerTag: pairs.known.prt ?? null,
        platform: platformOf(session.platform),
        now,
        cap: this.settings.get(SETTINGS.linksAutoDailyCap),
      });
      this.logger[outcome === "created" ? "log" : "debug"](JSON.stringify({ module: "links", event: "auto_source", result: outcome }));
    }

    if (parsed.unknownKeys !== undefined && parsed.unknownKeys.length > 0) await this.repository.noteUnknownKeys(parsed.unknownKeys, now);
    return outcome;
  }
}
