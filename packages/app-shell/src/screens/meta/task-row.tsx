import type { ReactNode } from "react";
import { Bot, Check, Crown, Crosshair, ExternalLink, Hourglass, Megaphone, Play, Sparkles, Target } from "lucide-react";
import { Badge, Button, Card, ProgressBar } from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/tasks";
import { isClaimable, isOpenKind, slotsText, tabOf, taskLink, type TaskItem } from "../../state/tasks-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { TaskImage } from "./task-image";
import { RewardChips } from "./task-reward";

/**
 * Строка задания — та, что игрок видит в «Заданиях»
 * (docs/35-stage4-plan.md WP13): своим модулем, потому что её же рисует
 * предпросмотр в панели (WP32). Картинку ей передают готовым адресом: игра
 * берёт адрес API из оболочки, предпросмотр — из своих настроек.
 */

const ICONS: Partial<Record<string, ReactNode>> = {
  runs: <Play size={20} aria-hidden="true" />,
  kills: <Crosshair size={20} aria-hidden="true" />,
  survive_sec: <Hourglass size={20} aria-hidden="true" />,
  best_survival_sec: <Crown size={20} aria-hidden="true" />,
  run_level: <Sparkles size={20} aria-hidden="true" />,
  channel: <Megaphone size={20} aria-hidden="true" />,
  link: <ExternalLink size={20} aria-hidden="true" />,
  bot: <Bot size={20} aria-hidden="true" />,
};

/** Цели во времени считаются в секундах, а читаются минутами. */
const TIME_KINDS: ReadonlySet<string> = new Set(["survive_sec", "best_survival_sec"]);

export function TaskRow(props: {
  index: number;
  task: TaskItem;
  /** картинка цели — полный адрес или `null`: строка не знает, откуда её берут игра и предпросмотр */
  image: string | null;
  claiming: boolean;
  notice: string | null;
  /** места кончились, пока экран открыт: действовать больше нечем */
  closed: boolean;
  onClaim: () => void;
  onOpen: (link: string) => void;
}): ReactNode {
  const { task } = props;
  const claimable = isClaimable(task) && !props.closed;
  const link = taskLink(task);
  // Подписку выполняет не забег: её проверяет сервер по нажатию, поэтому
  // «Проверить» есть и у невыполненной цели. Ссылку и бота выполняет переход.
  const waitsAction = link !== null && !task.done && !props.closed;
  const opens = waitsAction && isOpenKind(task.kind);
  const name = achievementName(task);
  // Места считаются при отрисовке, без тикающего таймера: экран заданий
  // перечитывается при каждом открытии и после каждого действия.
  const place = props.closed ? null : slotsText(task.slots, Date.now());
  const title = task.title ?? name ?? goalText(task);
  const hint = task.title === null && name !== null ? goalText(task) : (repeatHint(task) ?? null);

  return (
    <Card appearIndex={props.index} stripe={claimable ? "accent" : undefined}>
      <div className="flex items-center gap-3">
        <TaskImage
          src={props.image}
          fallback={
            <span
              className={[
                "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
                task.done ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
              ].join(" ")}
            >
              {ICONS[task.kind] ?? <Target size={20} aria-hidden="true" />}
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-sm font-bold text-text">{title}</span>
            {task.claimed ? (
              <Badge tone="muted">
                <Check size={12} aria-hidden="true" />
                {t("tasks.claimed")}
              </Badge>
            ) : task.done ? (
              <Badge tone="accent">
                <Check size={12} aria-hidden="true" />
                {t("tasks.done")}
              </Badge>
            ) : null}
          </div>
          {hint === null ? null : <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
          {place === null ? null : <p className="mt-0.5 font-display text-xs font-semibold text-accent">{t(place.key, place.params)}</p>}
          {link === null ? (
            <div className="mt-2">
              <ProgressLine task={task} />
            </div>
          ) : null}
        </div>
        <RewardChips reward={task.reward} />
      </div>
      {/* Под строкой и во всю ширину: в правой колонке кнопка сжимала полосу
          прогресса до точки на узком телефоне. */}
      {claimable ? (
        <div className="mt-3">
          <Button block loading={props.claiming} onClick={props.onClaim}>
            {t("tasks.claim")}
          </Button>
        </div>
      ) : null}
      {opens ? (
        <div className="mt-3">
          <Button block onClick={() => props.onOpen(link)}>
            <ExternalLink size={18} aria-hidden="true" />
            {t(task.kind === "bot" ? "tasks.startBot" : "tasks.go")}
          </Button>
        </div>
      ) : null}
      {waitsAction && !opens ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => props.onOpen(link)}>
            {t("tasks.subscribe")}
          </Button>
          <Button loading={props.claiming} onClick={props.onClaim}>
            {t("tasks.check")}
          </Button>
        </div>
      ) : null}
      {props.notice === null ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{props.notice}</p>}
    </Card>
  );
}

function ProgressLine(props: { task: TaskItem }): ReactNode {
  const { task } = props;
  const format = (value: number): string => (TIME_KINDS.has(task.kind) ? formatDuration(value) : formatNumber(value));
  const text = `${format(task.value)} / ${format(task.target)}`;

  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={task.value} max={task.target} height="thin" label={text} />
      <span aria-hidden="true" className="shrink-0 font-display text-xs tabular-nums text-text-muted">
        {text}
      </span>
    </div>
  );
}

/**
 * Повтор партнёрской подписки (Р82): награда за каждые сутки или неделю,
 * пока игрок подписан. Забрал — когда следующая; время считается при
 * отрисовке, без тикающего таймера, как у строки сброса.
 */
function repeatHint(task: TaskItem): string | null {
  if (tabOf(task) !== "partner" || task.period === "achievement") return null;
  // Число с единицей — неразрывно: «7 ч» не должно разъехаться по строкам.
  if (task.claimed) return t("tasks.repeat.next", { time: formatCountdown(msUntilReset(Date.now(), task.period)).replace(/(\d) /g, "$1\u00a0") });
  return t(task.period === "daily" ? "tasks.repeat.daily" : "tasks.repeat.weekly");
}

/** Имя достижения из словаря — у достижений по умолчанию; у своих из панели — заголовок каталога. */
function achievementName(task: TaskItem): string | null {
  const key = `achievement.${task.id}.name`;
  return task.period === "achievement" && hasTranslation(key) ? t(key) : null;
}

/**
 * Цель по виду — со склонением числа: `target` склоняет, `count` — то же число
 * с разрядами, как в полосе прогресса. Незнакомый вид без заголовка — просто
 * число цели.
 */
function goalText(task: TaskItem): string {
  const key = `task.kind.${task.kind}`;
  if (!hasTranslation(key)) return formatNumber(task.target);
  return t(key, { target: task.target, count: formatNumber(task.target), time: formatCountdown(task.target * 1000) });
}
