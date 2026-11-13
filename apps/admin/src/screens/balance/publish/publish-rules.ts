import type { Audience, CurrentPointers, PublicationPreview, PublishResult, RollbackResult, VersionSummary } from "../../../api/content";
import { plural } from "../../../format";
import type { Rails } from "../check/check-rules";

/**
 * Правила публикации в «Балансе» (tasks/T-0306): когда живут кнопки «Команде»
 * и «Всем», что показывает «История и откат», как читается окно «Всем» и
 * итоги действий. Без DOM и без запросов — всё проверяется тестом.
 */

export const AUDIENCE_LABEL: Record<Audience, string> = { team: "Команде", all: "Всем" };
/** Кого называем в итогах: «у команды», «у всех». */
const WHOM: Record<Audience, string> = { team: "команды", all: "всех" };
const AUDIENCES: readonly Audience[] = ["team", "all"];

export interface ButtonState {
  enabled: boolean;
  /** почему недоступна; `null` — доступна */
  hint: string | null;
}

export interface PublishUi {
  /** кнопок нет вовсе: нет права, нет черновика или экран телефона */
  visible: boolean;
  team: ButtonState;
  all: ButtonState;
}

/** Причина, по которой рельсы не дают публиковать; `null` — зелёные. */
function railsHint(rails: Rails): string | null {
  if (rails.ready) return null;
  const states = rails.steps.map((step) => step.state);
  if (states.includes("run")) return "Проверка идёт — дождитесь итога";
  if (states.includes("stale")) return "Прогон устарел — проверьте снова";
  if (states.every((state) => state === "idle")) return "Сначала «Проверить»: публикация идёт только после зелёной проверки";
  return "Проверка не зелёная — исправьте замечания и проверьте снова";
}

/**
 * Кнопки живут только при зелёных рельсах T-0305: схема, проверки и
 * симуляция в коридорах, прогон свежий. Сервер проверяет то же самое ещё раз —
 * кнопка лишь не зовёт его впустую. На телефоне править и публиковать нельзя:
 * там остаются просмотр и откат.
 */
export function publishUi(input: { rails: Rails; canPublish: boolean; narrow: boolean; hasDraft: boolean; busy: boolean }): PublishUi {
  const hint = input.busy ? "Идёт публикация…" : railsHint(input.rails);
  const state: ButtonState = { enabled: hint === null, hint };
  return { visible: input.canPublish && input.hasDraft && !input.narrow, team: state, all: state };
}

const SOURCE_NOTE = "из кода";
const NEW_CONCEPT_NOTE = "из кода — новое понятие";

export interface HistoryRow {
  versionNo: number;
  source: "panel" | "repo";
  /** «вы», «из кода» или начало номера аккаунта: имени в ответе сервера нет */
  author: string;
  /** когда версия вышла в игру, а без этого — когда заведена; ISO */
  date: string;
  /** у каких аудиторий версия в игре сейчас */
  live: Audience[];
  /** на какую аудиторию её можно откатить */
  rollbackTo: Audience[];
  takeFromCode: boolean;
  /** пометка под строкой; `null` — нечего сказать */
  note: string | null;
}

function pointerOf(current: CurrentPointers, audience: Audience): number | null {
  // Нет указателя команды — она играет версией «всем».
  return audience === "team" ? (current.team ?? current.all)?.versionNo ?? null : current.all?.versionNo ?? null;
}

function authorOf(version: VersionSummary, meId: string): string {
  if (version.source === "repo") return SOURCE_NOTE;
  if (version.createdBy === null) return "—";
  return version.createdBy === meId ? "вы" : `№${version.createdBy.slice(0, 8)}`;
}

/**
 * Строки «Истории»: новые сверху. Откат — на версию, что бывала в игре
 * (`publishedAt`) и у аудитории сейчас не стоит; откатывать «нечего», пока
 * ничего не публиковалось. «Взять из кода» — у последней версии из кода, что
 * ждёт рядом: старые ждущие уже устарели, а из панельной версии брать нечего.
 */
export function historyRows(input: { versions: readonly VersionSummary[]; current: CurrentPointers; canPublish: boolean; canEdit: boolean; hasDraft: boolean; meId: string }): HistoryRow[] {
  const sorted = [...input.versions].sort((a, b) => b.versionNo - a.versionNo);
  const newestRepo = sorted.find((version) => version.source === "repo")?.versionNo ?? null;
  return sorted.map((version): HistoryRow => {
    const waiting = version.source === "repo" && version.publishedAt === null;
    const isNewConcept = waiting && version.versionNo === newestRepo;
    const rollbackTo = AUDIENCES.filter((audience) => {
      const live = pointerOf(input.current, audience);
      return input.canPublish && version.publishedAt !== null && live !== null && live !== version.versionNo;
    });
    return {
      versionNo: version.versionNo,
      source: version.source === "repo" ? "repo" : "panel",
      author: authorOf(version, input.meId),
      date: version.publishedAt ?? version.createdAt,
      live: AUDIENCES.filter((audience) => pointerOf(input.current, audience) === version.versionNo),
      rollbackTo,
      takeFromCode: isNewConcept && input.canEdit && input.hasDraft,
      note: isNewConcept ? NEW_CONCEPT_NOTE : waiting ? SOURCE_NOTE : null,
    };
  });
}

export interface DialogModel {
  title: string;
  summary: string;
  warnings: string[];
  canConfirm: boolean;
}

/** Окно «Опубликовать всем?»: что изменится, чем рискуем и можно ли подтверждать. */
export function dialogModel(preview: PublicationPreview): DialogModel {
  const count = `${String(preview.changes.length)}${preview.truncated ? "+" : ""}`;
  const against = preview.liveVersionNo === null ? "встроенного контента" : `v${String(preview.liveVersionNo)}, которая сейчас в игре у всех`;
  const summary =
    preview.changes.length === 0
      ? `Черновик не отличается от ${against}.`
      : `Против ${against}: ${count} ${plural(preview.changes.length, ["правка", "правки", "правок"])}.`;
  const warnings: string[] = [];
  if (!preview.ready && preview.reason !== null) warnings.push(preview.reason);
  if (preview.alreadyLive) warnings.push("Эта версия уже в игре у всех — публиковать нечего.");
  else if (preview.ready && !preview.onTeam) warnings.push("Эту версию команда ещё не смотрела — «Всем» выкатит её сразу всем игрокам.");
  return { title: "Опубликовать всем?", summary, warnings, canConfirm: preview.ready && !preview.alreadyLive };
}

export function resultText(audience: Audience, result: Pick<PublishResult, "versionNo" | "created" | "changed">): string {
  const version = `v${String(result.versionNo)}`;
  if (!result.created && !result.changed) return `${version} уже в игре у ${WHOM[audience]} — ничего не изменилось`;
  if (result.created) return `Опубликована ${version} для ${audience === "all" ? "всех" : "команды"}`;
  return `${version} теперь у ${audience === "all" ? "всех" : "команды"}`;
}

export function rollbackText(audience: Audience, result: Pick<RollbackResult, "versionNo" | "changed">): string {
  const version = `v${String(result.versionNo)}`;
  return result.changed ? `Откат: у ${WHOM[audience]} снова ${version}` : `${version} уже у ${WHOM[audience]} — ничего не изменилось`;
}
