import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { pullRequestsForCommit } from "./git.mjs";

/**
 * Сводка для команды и черновик поста в канал — из описания PR в Telegram
 * (docs/09-ci-cd.md §7, «Сводка в Telegram»).
 *
 * Текст пишется **один раз, в описании PR**, разделами `## Сводка для
 * команды` и `## Пост в канал`, и проходит ревью вместе с кодом. После
 * мерджа workflow `team-summary.yml` отправляет его ботом: сводку — в чат
 * администраторов, пост — черновиком в отдельную тему, чтобы не забивать
 * ленту. Публикует пост человек — пересылкой «без автора», которая
 * сохраняет оформление целиком. Автопост в публичный канал сознательно не
 * делается: опечатка или лишняя подробность ушли бы сразу всем подписчикам,
 * а удалённый пост успевают прочитать.
 *
 * Запуск — на push в `dev` и `main`, а PR находится по коммиту. Не на
 * событие PR: его GitHub сверяет с правилом веток окружения как
 * `refs/pull/N/merge`, и окружение, открытое только `dev` и `main`, такой
 * джоб не пустило бы; а открыть его PR-ссылкам значит отдать секрет любому
 * PR, даже невлитому.
 *
 * Чистые функции — разбор раздела, перевод разметки, нарезка — покрыты
 * тестами; `main` в конце файла — тонкая обвязка над Bot API.
 */

export const TEAM_SECTION = "Сводка для команды";
export const CHANNEL_SECTION = "Пост в канал";

/** Предел длины сообщения Bot API. */
export const TELEGRAM_LIMIT = 4096;

/** Закрывашка поста в канал: без неё у пересланного текста теряется источник. */
export const CHANNEL_SIGNATURE = "🚀 @KennixDev | 🙏 <a href=\"https://t.me/KennixDev/35\">Поддержать</a>";
const DEFAULT_HASHTAGS = "#Разработка #Dev #GameDev #Telegram";
const SEPARATOR = "———————";

/**
 * Раздел `## Заголовок` из описания PR — до следующего заголовка второго
 * уровня. Нет раздела или он пуст — `null`: отправлять нечего, и это не
 * ошибка (служебные PR сводку не пишут). HTML-комментарии — подсказки шаблона
 * — вырезаются.
 */
export function extractSection(body, title) {
  if (typeof body !== "string" || body === "") return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
  return section === "" ? null : section;
}

/**
 * Разметка описания PR → HTML Bot API.
 *
 * Правила — те, по которым текст и так пишется (память команды об
 * оформлении): первая строка — заголовок, жирный; строка «эмодзи +
 * **жирное**» — заголовок раздела, и бот сразу оборачивает его в цитату,
 * которую раньше ставили руками; `` `код` `` — моноширинный; `[текст](адрес)`
 * — ссылка. Остальное — как есть: списков в Telegram нет, `•` остаётся `•`.
 */
export function toTelegramHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line, index) => {
      const html = inline(escapeHtml(line));
      if (index > 0 && isSectionHeader(line)) return `<blockquote>${html}</blockquote>`;
      return html;
    })
    .join("\n");
}

/** Строка — это заголовок раздела: эмодзи, пробел, целиком жирный текст. */
export function isSectionHeader(line) {
  return /^\p{Extended_Pictographic}[\p{Extended_Pictographic}️‍]*\s+\*\*[^*]+\*\*\s*(\([^)]*\))?\s*$/u.test(line.trim());
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/**
 * Пост в канал всегда кончается закрывашкой. Её допишет сам скрипт, если
 * автор забыл: хэштеги — свои, если строка с ними есть, иначе общие.
 */
export function withChannelSignature(html) {
  if (html.includes("@KennixDev")) return html;
  const hasHashtags = /(^|\n)#\S/.test(html.split(SEPARATOR).at(-1) ?? "");
  const tail = [SEPARATOR, ...(hasHashtags ? [] : [DEFAULT_HASHTAGS]), CHANNEL_SIGNATURE];
  return `${html.trimEnd()}\n${tail.join("\n")}`;
}

/**
 * Нарезать по пределу Bot API — по абзацам, а не посреди слова или тега.
 * Абзац длиннее предела режется по строкам; строка длиннее — по символам,
 * но такого текста в сводке быть не должно.
 */
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = "";
  for (const block of text.split("\n\n")) {
    const candidate = current === "" ? block : `${current}\n\n${block}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== "") parts.push(current);
    if (block.length <= limit) {
      current = block;
      continue;
    }
    for (let offset = 0; offset < block.length; offset += limit) parts.push(block.slice(offset, offset + limit));
    current = "";
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * Участники команды для упоминаний. Юзернеймы — в секретах окружения, а не в
 * репозитории: он публичный, а светить свой юзернейм хотят не все. В описании
 * PR пишется заглушка `@участник1`, бот при отправке подставляет юзернейм.
 *
 * Упоминание — явная заглушка, а не каждое «участник 1» в тексте: упоминание
 * будит человека уведомлением, и оно нужно там, где от него что-то требуется,
 * а не везде, где он назван.
 */
export const MEMBERS = [
  { placeholder: "участник1", role: "участник 1", secret: "TEAM_TELEGRAM_MEMBER_1" },
  { placeholder: "участник2", role: "участник 2", secret: "TEAM_TELEGRAM_MEMBER_2" },
  { placeholder: "участник3", role: "участник 3", secret: "TEAM_TELEGRAM_MEMBER_3" },
];
/** `@команда` — все, у кого задан юзернейм. */
const EVERYONE = "команда";
const MENTION = /@(участник[123]|команда)(?![\p{L}\p{N}_])/giu;

/**
 * Юзернеймы из окружения. Значение с `@` или без; то, что не похоже на
 * юзернейм Telegram, отбрасывается целиком — в `invalid` попадает имя секрета,
 * но не значение: оно секретное.
 */
export function teamUsernames(env) {
  const usernames = {};
  const invalid = [];
  for (const member of MEMBERS) {
    const value = (env[member.secret] ?? "").trim().replace(/^@/, "");
    if (value === "") continue;
    if (/^[A-Za-z0-9_]{4,32}$/.test(value)) usernames[member.placeholder] = value;
    else invalid.push(member.secret);
  }
  return { usernames, invalid };
}

/**
 * Заглушки → `@юзернейм`. Юзернейм не задан — имя роли: сообщение остаётся
 * читаемым, а `missing` называет секреты, которых не хватило. Внутри
 * `<code>` заглушки не трогаются: там синтаксис описывают, а не зовут людей.
 */
export function withMentions(html, usernames) {
  const missing = new Set();
  const render = (member) => {
    const username = usernames[member.placeholder];
    if (username === undefined) missing.add(member.secret);
    return username === undefined ? member.role : `@${username}`;
  };
  const replace = (_match, name) => {
    const key = name.toLowerCase();
    let text;
    if (key === EVERYONE) {
      const present = MEMBERS.filter((member) => usernames[member.placeholder] !== undefined);
      for (const member of MEMBERS) if (usernames[member.placeholder] === undefined) missing.add(member.secret);
      text = present.length > 0 ? present.map(render).join(" ") : EVERYONE;
    } else {
      text = render(MEMBERS.find((member) => member.placeholder === key));
    }
    // «@Участник1, проверь…» в начале фразы не должно стать «участник 1, проверь…».
    return name[0] === name[0].toUpperCase() ? text[0].toUpperCase() + text.slice(1) : text;
  };
  const text = html
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(MENTION, replace)))
    .join("");
  return { text, missing: [...missing] };
}

/** Адрес чата: `id` или `id:тема` — та же запись, что у ADMIN_CHAT_* бэкенда. */
export function parseChatTarget(value) {
  const match = /^(-?\d+)(?::(\d+))?$/.exec((value ?? "").trim());
  if (match === null) return null;
  return { chatId: match[1], threadId: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * Что и куда отправить по влитому PR. Пустой список — отправлять нечего.
 *
 * Черновик поста уходит **только** в свою тему: запасного пути в ленту
 * команды нет намеренно — ради этого тема и заведена. Нет темы — черновик
 * не отправляется, а `warnings` объясняет почему.
 *
 * Юзернеймы подставляются только в сводку. В черновике заглушка становится
 * именем роли: пост уйдёт в публичный канал, а юзернеймы прячут именно от него.
 */
export function plannedMessages(body, chats, usernames = {}) {
  const messages = [];
  const warnings = [];

  const team = extractSection(body, TEAM_SECTION);
  if (team !== null) {
    if (chats.team === null) {
      warnings.push("сводка: не задан TEAM_TELEGRAM_CHAT");
    } else {
      const { text, missing } = withMentions(toTelegramHtml(team), usernames);
      if (missing.length > 0) warnings.push(`упоминания: не заданы ${missing.join(", ")} — в сводке вместо юзернейма имя роли`);
      for (const part of splitMessage(text)) messages.push({ target: chats.team, text: part });
    }
  }

  const channel = extractSection(body, CHANNEL_SECTION);
  if (channel !== null) {
    if (chats.drafts === null) {
      warnings.push("черновик поста: не задан TEAM_TELEGRAM_DRAFTS_CHAT — в ленту команды он не идёт");
    } else {
      const draft = withChannelSignature(withMentions(toTelegramHtml(channel), {}).text);
      messages.push({ target: chats.drafts, text: "✍️ <b>Черновик поста в канал</b> — перешлите «без автора», оформление сохранится" });
      for (const part of splitMessage(draft)) messages.push({ target: chats.drafts, text: part });
    }
  }
  return { messages, warnings };
}

/**
 * PR, чьим мерджем стал этот коммит. GitHub связывает коммит со всеми PR, где
 * он есть, — в том числе с открытым релизным `dev` → `main`, куда он уже
 * попал. Нужен ровно тот, у которого этот коммит — коммит мерджа.
 * Не нашёлся — это перемотка синка или прямой push: сводки у них нет.
 */
export function pullRequestForPush(sha, pullRequests) {
  return pullRequests.find((pr) => pr.merged_at && pr.merge_commit_sha === sha) ?? null;
}

async function send(token, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: message.target.chatId,
        ...(message.target.threadId === null ? {} : { message_thread_id: message.target.threadId }),
        text: message.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: controller.signal,
    });
    const answer = await response.json().catch(() => ({}));
    // Токен в текст ошибки не попадает: адрес с ним здесь не печатается.
    if (!response.ok || answer.ok !== true) throw new Error(`Bot API ответил ${response.status}: ${answer.description ?? "без описания"}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const sha = process.env.GITHUB_SHA ?? "";
  const pr = await findPullRequest(sha);
  if (pr === null) {
    console.log(`коммит ${sha}: влитого PR нет — перемотка или прямой push, отправлять нечего`);
    return;
  }

  const chats = {
    team: parseChatTarget(process.env.TEAM_TELEGRAM_CHAT),
    drafts: parseChatTarget(process.env.TEAM_TELEGRAM_DRAFTS_CHAT),
  };
  const { usernames, invalid } = teamUsernames(process.env);
  for (const secret of invalid) console.log(`::warning::${secret} не похож на юзернейм Telegram — вместо упоминания будет имя роли`);
  const { messages, warnings } = plannedMessages(pr.body ?? "", chats, usernames);
  for (const reason of warnings) console.log(`::warning::PR #${pr.number}: ${reason}`);

  if (messages.length === 0) {
    console.log(`PR #${pr.number}: разделов «${TEAM_SECTION}» и «${CHANNEL_SECTION}» нет — отправлять нечего`);
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  // Секрета нет — окружение не настроено. Это не падение сборки, но и не
  // молчание: предупреждение видно в сводке прогона.
  if (token === "") {
    console.log("::warning::TELEGRAM_BOT_TOKEN не задан — сводка не отправлена (docs/09-ci-cd.md §7)");
    return;
  }
  for (const message of messages) await send(token, message);
  console.log(`PR #${pr.number}: отправлено сообщений — ${messages.length}`);
}

/**
 * Связь коммита с PR у GitHub появляется не мгновенно: сразу после мерджа
 * список бывает пуст. Несколько коротких повторов дешевле пропавшей сводки.
 */
async function findPullRequest(sha) {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const found = pullRequestForPush(sha, pullRequestsForCommit(sha));
    if (found !== null || attempt === attempts) return found;
    await sleep(3_000);
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
