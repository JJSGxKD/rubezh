import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { Button, Card, SectionTitle } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { createBotMentionApi, isKnownOutcome, type BotMentionTask, type BotMentionView } from "../../state/bot-mention-api";
import { track } from "../../state/shell";
import { tasksAvailable } from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { buttonKey, collapsedStreak, outcomeKey, statusKey, visibleTasks } from "./bot-mention-rules";
import { RewardChips, rewardText } from "./task-reward";

/**
 * Задания «юзернейм бота в имени и в bio» — блок над вкладками экрана «Задания»
 * (docs/35-stage4-plan.md Р110, Р167, tasks/T-0160, T-0337). Проверку, серию и награду ведёт
 * сервер: клиент показывает ответ и присылает один вид задания.
 *
 * Блок не мешает экрану: пока грузится, а также при ошибке, без входа, на
 * площадке без заданий и при пустом списке он ничего не рисует. Анимаций нет,
 * поэтому нового переключателя настроек блок не требует. Получив награду за сутки
 * у всех видов, блок сворачивается в строку «Серия N дней · завтра снова»;
 * касание разворачивает, а нажатие кнопки в карточке держит блок развёрнутым до
 * закрытия экрана — иначе сообщение «Нашли!» исчезло бы непрочитанным.
 */

const api = createBotMentionApi();

const KIND_TITLE: Readonly<Record<string, string>> = { name: "botMention.name.title", bio: "botMention.bio.title" };
const KIND_HINT: Readonly<Record<string, string>> = { name: "botMention.name.hint", bio: "botMention.bio.hint" };

export function BotMentionRows(): ReactNode {
  const [view, setView] = useState<BotMentionView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const alive = useRef(true);
  // Замок на нажатие: состояние обновится только после отрисовки, а второе нажатие может прийти раньше.
  const pending = useRef(false);

  useEffect(() => {
    alive.current = true;
    if (tasksAvailable()) {
      void api.view().then((response) => {
        if (alive.current && response.ok) setView(response.data);
      });
    }
    return () => {
      alive.current = false;
    };
  }, []);

  if (!tasksAvailable() || view === null) return null;
  const shown = visibleTasks(view);
  const bot = view.botUsername;
  if (bot === null || shown.length === 0) return null;

  const say = (kind: string, text: string): void => setMessages((current) => ({ ...current, [kind]: text }));

  const press = async (task: BotMentionTask): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setExpanded(true);
    setBusy(task.kind);
    const wasStarted = task.started;
    const response = await api.check(task.kind);
    pending.current = false;
    if (!alive.current) return;
    setBusy(null);
    if (!response.ok) {
      // Ошибка запроса данные карточки не меняет: нет сети, лимит частоты, сбой сервера.
      say(task.kind, t("botMention.outcome.failed"));
      return;
    }

    const { outcome, credited } = response.data;
    setView(response.data.view);
    const gained = credited.coins + credited.gems + credited.shards > 0;
    say(task.kind, outcome === "present" && gained ? t("botMention.outcome.present", { what: rewardText(credited) }) : t(outcomeKey(outcome === "present" ? "done_today" : outcome)));
    if (isKnownOutcome(outcome) && (task.kind === "name" || task.kind === "bio")) {
      if (!wasStarted) track("bot_mention_started", { kind: task.kind });
      track("bot_mention_checked", { kind: task.kind, outcome });
    }
    if (gained) void loadWallet();
    void loadBadges();
  };

  return <BotMentionBlock botUsername={bot} tasks={shown} expanded={expanded} busyKind={busy} messages={messages} onToggle={() => setExpanded((value) => !value)} onPress={(task) => void press(task)} />;
}

export interface BotMentionBlockProps {
  botUsername: string | null;
  /** показываемые виды (`visibleTasks`) */
  tasks: readonly BotMentionTask[];
  /** игрок развернул блок или нажал кнопку в карточке */
  expanded: boolean;
  busyKind: string | null;
  messages: Readonly<Record<string, string>>;
  onToggle: () => void;
  onPress: (task: BotMentionTask) => void;
}

/** Строка-кнопка блока: свёрнутый вид (серия) или заголовок развёрнутого, который можно свернуть. */
function BlockToggle(props: { open: boolean; children: ReactNode; onToggle: () => void }): ReactNode {
  const Chevron = props.open ? ChevronUp : ChevronDown;
  return (
    <button type="button" aria-expanded={props.open} onClick={props.onToggle} className="flex min-h-11 w-full items-center gap-3 rounded-md bg-surface-raised px-3 text-left">
      <Bot size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-text">{props.children}</span>
      <Chevron size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
      <span className="sr-only">{props.open ? t("botMention.collapse") : t("botMention.expand")}</span>
    </button>
  );
}

/** Блок без состояния: его рендерят и экран, и тесты. Нет юзернейма бота или видов — ничего не рисует. */
export function BotMentionBlock(props: BotMentionBlockProps): ReactNode {
  const { botUsername, tasks } = props;
  if (botUsername === null || tasks.length === 0) return null;
  const streak = collapsedStreak(tasks);

  if (streak !== null && !props.expanded) {
    return (
      <section aria-label={t("botMention.title")} className="mt-2">
        <BlockToggle open={false} onToggle={props.onToggle}>
          {t("botMention.collapsed", { n: streak })}
        </BlockToggle>
      </section>
    );
  }

  return (
    <section aria-label={t("botMention.title")} className="mt-2">
      {streak === null ? (
        <SectionTitle>{t("botMention.title")}</SectionTitle>
      ) : (
        <BlockToggle open onToggle={props.onToggle}>
          {t("botMention.title")}
        </BlockToggle>
      )}
      <div className="mt-2 grid gap-2">
        {tasks.map((task) => (
          <BotMentionCard key={task.kind} botUsername={botUsername} task={task} loading={props.busyKind === task.kind} message={props.messages[task.kind] ?? null} onPress={() => props.onPress(task)} />
        ))}
      </div>
    </section>
  );
}

export interface BotMentionCardProps {
  /** что вписать, без «@» */
  botUsername: string;
  task: BotMentionTask;
  /** запрос идёт: кнопка занята, повторное нажатие не действует */
  loading: boolean;
  /** сообщение под кнопкой после ответа или ошибки */
  message: string | null;
  onPress: () => void;
}

/** Одна карточка — без состояния: её рендерят и экран, и тесты. */
export function BotMentionCard(props: BotMentionCardProps): ReactNode {
  const { task } = props;
  const status = statusKey(task);
  const button = buttonKey(task);
  const showBest = task.bestStreak > task.streak;

  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
          <Bot size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="font-display text-sm font-bold text-text">{t(KIND_TITLE[task.kind] ?? "botMention.title")}</span>
          <p className="mt-0.5 text-xs text-text-muted">{withBotName(t(KIND_HINT[task.kind] ?? "botMention.title", { bot: `@${props.botUsername}` }), props.botUsername)}</p>
        </div>
        <RewardChips reward={task.reward} />
      </div>
      {task.streak > 0 ? <p className="mt-2 font-display text-xs font-semibold text-accent">{t("botMention.streak", { n: task.streak })}</p> : null}
      {showBest ? <p className="mt-0.5 text-xs text-text-muted">{t("botMention.best", { n: formatNumber(task.bestStreak) })}</p> : null}
      {status === null ? null : <p className="mt-2 text-xs text-text-muted">{t(status)}</p>}
      {button === null ? null : (
        <div className="mt-3">
          <Button track="bot_action" block loading={props.loading} onClick={props.onPress}>
            {t(button)}
          </Button>
        </div>
      )}
      {!task.started && !task.rewardedToday ? <p className="mt-2 text-xs text-text-muted">{t("botMention.auto")}</p> : null}
      {props.message === null ? null : (
        <p role="status" className="mt-2 text-xs font-semibold text-text-muted">
          {props.message}
        </p>
      )}
    </Card>
  );
}

/**
 * Юзернейм в тексте — отдельным элементом: моноширинный, выделяемый системным
 * способом, с переносом по знакам, чтобы длинное имя не вылезло за край.
 */
function withBotName(text: string, botUsername: string): ReactNode {
  const token = `@${botUsername}`;
  const at = text.indexOf(token);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="font-mono font-semibold break-all text-text select-text">{token}</span>
      {text.slice(at + token.length)}
    </>
  );
}
