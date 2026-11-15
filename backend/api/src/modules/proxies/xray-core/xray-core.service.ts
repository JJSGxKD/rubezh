import { Logger } from "@nestjs/common";
import { compareXrayVersions, parseXrayVersion, XRAY_CORE_BLOCKS, XRAY_CORE_MAX, XRAY_CORE_MIN, xrayCompatibility, type XrayCompatibility, type XrayCoreBlock } from "@bh/proxy-kit";
import type { AccountRef, RolesService } from "../../roles/roles.service.js";
import { SECRETS } from "../../secrets/secret-catalog.js";
import type { SecretsReader } from "../../secrets/secrets.service.js";
import { XrayReleaseChangedError, XrayUpdateBlockedError, type RefusingBlock } from "./xray-core-errors.js";
import type { LatestRelease, XrayReleases } from "./xray-core-releases.js";
import { readCoreStatus, type CoreStatus } from "./xray-core-status.js";
import type { LastRun, XrayCoreUpdater } from "./xray-core-update.js";

/**
 * «Ядро Xray» в панели (docs/35-stage4-plan.md Р202, tasks/T-0416): запущенная
 * версия, свежий выпуск, совместимость обеих с нашим конфигом и запуск
 * обновления. Смотреть — `proxies.view`, проверять выпуск и запускать —
 * `proxies.edit` (только владелец, Р91). Сравнений версий здесь нет:
 * совместимость считает `@bh/proxy-kit`, а кнопку закрывает первая причина из
 * `UpdateBlock`; сервер повторяет ту же проверку при запуске.
 */

export type UpdateBlock = RefusingBlock | "locked";

/** Проверенный диапазон и блоки: тесты подменяют их, не трогая пакет. */
export interface CompatOptions {
  min: string;
  max: string;
  blocks: readonly XrayCoreBlock[];
}

export interface XrayCoreView {
  running: { state: "ok" | "missing" | "unreadable"; version: string | null; startedAt: string | null; compatibility: XrayCompatibility | null };
  tested: { min: string; max: string };
  latest: { version: string; publishedAt: string | null; url: string; checkedAt: string; compatibility: XrayCompatibility } | null;
  latestError: string | null;
  update: {
    configured: boolean;
    blockedBy: UpdateBlock | null;
    lastRun: LastRun | null;
    lastRunError: string | null;
    lockedUntil: string | null;
  };
}

export interface XrayCoreDeps {
  roles: Pick<RolesService, "require" | "audit">;
  secrets: SecretsReader;
  releases: XrayReleases;
  updater: XrayCoreUpdater;
  /** файл статуса ядра (`XRAY_STATUS_PATH`) */
  statusPath: string;
  compat?: CompatOptions;
  /** строка журнала; по умолчанию — лог Nest */
  log?: (line: string) => void;
  now?: () => number;
}

/** Всё, что нужно, чтобы назвать причину закрытой кнопки. */
interface Gathered {
  status: CoreStatus;
  token: string | null;
  latest: LatestRelease | null;
  latestError: string | null;
  lastRun: LastRun | null;
  lastRunError: string | null;
  lockedUntil: Date | null;
}

export class XrayCoreService {
  private readonly compat: CompatOptions;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: XrayCoreDeps) {
    this.compat = deps.compat ?? { min: XRAY_CORE_MIN, max: XRAY_CORE_MAX, blocks: XRAY_CORE_BLOCKS };
    const logger = new Logger("xray-core");
    this.log = deps.log ?? ((line) => logger.log(line));
  }

  async view(actor: AccountRef): Promise<XrayCoreView> {
    await this.deps.roles.require(actor, "proxies.view");
    return this.present(await this.gather());
  }

  /** «Проверить сейчас»: мимо кэша выпуска, не чаще раза в минуту на всех. Это чтение, в аудит не идёт. */
  async refresh(actor: AccountRef): Promise<XrayCoreView> {
    await this.deps.roles.require(actor, "proxies.edit");
    await this.deps.releases.refresh();
    return this.present(await this.gather());
  }

  /**
   * Запустить обновление до версии из кэша сервера. Тело запроса несёт версию
   * только как подтверждение: другую запустить нельзя.
   */
  async update(actor: AccountRef, version: string): Promise<XrayCoreView> {
    await this.deps.roles.require(actor, "proxies.edit");
    const state = await this.gather();
    const block = this.blockOf(state);
    // Замок решает сам запуск: он атомарен, а проверка здесь — нет.
    if (block !== null && block.block !== "locked") throw new XrayUpdateBlockedError(block.block, block.reason);
    if (state.token === null || state.latest === null) throw new XrayUpdateBlockedError("no_release");
    if (state.latest.version !== version) throw new XrayReleaseChangedError();

    await this.deps.updater.dispatch(state.token, version, actor.accountId);

    const running = state.status.state === "ok" ? state.status.version : null;
    await this.deps.roles.audit({ actorAccountId: actor.accountId, action: "proxies.xray_core.update", target: version, after: { version, running } });
    this.log(JSON.stringify({ module: "xray-core", event: "update_dispatched", version, actor: actor.accountId }));
    return this.present(await this.gather());
  }

  private async gather(): Promise<Gathered> {
    const status = await readCoreStatus(this.deps.statusPath);
    const token = this.deps.secrets.get(SECRETS.githubXrayUpdate);
    const { release, error } = await this.deps.releases.latest();
    const lastRun = token === null ? { run: null, error: null } : await this.deps.updater.lastRun(token);
    return { status, token, latest: release, latestError: error, lastRun: lastRun.run, lastRunError: lastRun.error, lockedUntil: await this.deps.updater.lockedUntil() };
  }

  private compatibilityOf(version: string): XrayCompatibility {
    return xrayCompatibility(version, { min: this.compat.min, max: this.compat.max }, this.compat.blocks);
  }

  /** Первая причина по списку решений Р202; `null` — кнопка открыта. */
  private blockOf(state: Gathered): { block: UpdateBlock; reason: string | null } | null {
    if (state.token === null) return { block: "no_token", reason: null };
    if (state.latest === null) return { block: "no_release", reason: null };
    const compatibility = this.compatibilityOf(state.latest.version);
    if (compatibility.kind === "blocked") return { block: "blocked", reason: compatibility.reason };
    if (compatibility.kind === "older") return { block: "older", reason: null };
    if (state.status.state === "ok") {
      const running = parseXrayVersion(state.status.version);
      const latest = parseXrayVersion(state.latest.version);
      if (running !== null && latest !== null && compareXrayVersions(running, latest) >= 0) return { block: "up_to_date", reason: null };
    }
    // Не новее проверенного максимума — версия уже в коде и уедет с выпуском.
    if (compatibility.kind === "tested") return { block: "in_code", reason: null };
    if (state.lastRun?.active === true) return { block: "running", reason: null };
    if (state.lockedUntil !== null) return { block: "locked", reason: null };
    return null;
  }

  private present(state: Gathered): XrayCoreView {
    const ok = state.status.state === "ok" ? state.status : null;
    return {
      running: {
        state: state.status.state,
        version: ok?.version ?? null,
        startedAt: ok?.startedAt?.toISOString() ?? null,
        compatibility: ok === null ? null : this.compatibilityOf(ok.version),
      },
      tested: { min: this.compat.min, max: this.compat.max },
      latest: state.latest === null ? null : { ...state.latest, compatibility: this.compatibilityOf(state.latest.version) },
      latestError: state.latestError,
      update: {
        configured: state.token !== null,
        blockedBy: this.blockOf(state)?.block ?? null,
        lastRun: state.lastRun,
        lastRunError: state.lastRunError,
        lockedUntil: state.lockedUntil?.toISOString() ?? null,
      },
    };
  }
}
