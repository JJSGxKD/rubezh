import { describe, expect, it } from "vitest";
import {
  CHANNEL_SECTION,
  TEAM_SECTION,
  extractSection,
  isSectionHeader,
  parseChatTarget,
  plannedMessages,
  pullRequestForPush,
  splitMessage,
  toTelegramHtml,
  withChannelSignature,
  // @ts-expect-error — утилита CI на чистом JS, типов у неё нет и не нужно
} from "../release/team-summary.mjs";

// Сводка в Telegram из описания PR (docs/09-ci-cd.md §7). Цена ошибки здесь —
// не упавшая сборка, а сломанное сообщение в чате команды: съеденный раздел,
// незакрытый тег, из-за которого Bot API отвергает весь текст, или токен в
// логе. Поэтому разбор и разметка проверяются по одному правилу за раз.

const BODY = [
  "## Что это",
  "Описание для ревьюера.",
  "",
  `## ${TEAM_SECTION}`,
  "<!-- подсказка шаблона -->",
  "📋 **СВОДКА: В DEV ВЛИТ PR #50**",
  "",
  "Короткое вступление.",
  "",
  "🔐 **Раздел**",
  "",
  "Текст с `кодом`.",
  "",
  "## Проверка",
  "Гейт зелёный.",
].join("\n");

describe("раздел из описания PR", () => {
  it("берётся до следующего заголовка второго уровня", () => {
    const section = extractSection(BODY, TEAM_SECTION);

    expect(section?.startsWith("📋 **СВОДКА")).toBe(true);
    expect(section).not.toContain("Гейт зелёный");
  });

  it("подсказки шаблона в комментариях вырезаются", () => {
    expect(extractSection(BODY, TEAM_SECTION)).not.toContain("подсказка");
  });

  it("нет раздела — нечего отправлять, и это не ошибка", () => {
    expect(extractSection("## Что это\nтекст", TEAM_SECTION)).toBeNull();
    expect(extractSection("", TEAM_SECTION)).toBeNull();
    expect(extractSection(null, TEAM_SECTION)).toBeNull();
  });

  it("раздел из одних подсказок считается пустым", () => {
    expect(extractSection(`## ${TEAM_SECTION}\n<!-- написать сводку -->\n## Дальше`, TEAM_SECTION)).toBeNull();
  });

  it("переводы строк Windows не ломают разбор: описание PR правят и оттуда", () => {
    expect(extractSection(BODY.replace(/\n/g, "\r\n"), TEAM_SECTION)).not.toBeNull();
  });
});

describe("разметка для Telegram", () => {
  it("жирный, код и ссылки — в теги Bot API", () => {
    expect(toTelegramHtml("**важно** и `pnpm test`, см. [план](https://example.org/plan)")).toBe(
      '<b>важно</b> и <code>pnpm test</code>, см. <a href="https://example.org/plan">план</a>',
    );
  });

  it("угловые скобки и амперсанд экранируются: иначе Bot API отвергнет весь текст", () => {
    expect(toTelegramHtml("Promise<void> & Map<K, V>")).toBe("Promise&lt;void&gt; &amp; Map&lt;K, V&gt;");
  });

  it("заголовок раздела сразу в цитате — то, что раньше ставили руками", () => {
    const html = toTelegramHtml("📋 **СВОДКА**\n\n🔐 **Раздел**\n\nтекст");

    expect(html).toContain("<blockquote>🔐 <b>Раздел</b></blockquote>");
  });

  it("первая строка — заголовок сообщения, в цитату не уходит", () => {
    expect(toTelegramHtml("📋 **СВОДКА**\n\nтекст").startsWith("📋 <b>СВОДКА</b>")).toBe(true);
  });

  it("жирное посреди абзаца заголовком раздела не считается", () => {
    expect(isSectionHeader("Минимальная версия — **7.7**, и это не заголовок")).toBe(false);
    expect(isSectionHeader("🔐 **Раздел**")).toBe(true);
    expect(isSectionHeader("⚠️ **Что дальше по авторизации**")).toBe(true);
    expect(isSectionHeader("🛠️ **Что происходило под капотом** (коротко, для интересующихся)")).toBe(true);
  });
});

describe("пост в канал", () => {
  it("кончается закрывашкой, даже если автор её забыл", () => {
    const post = withChannelSignature("🎮 <b>ЗАГОЛОВОК</b>\n\nтекст");

    expect(post).toContain("———————");
    expect(post).toContain("#Разработка #Dev #GameDev #Telegram");
    expect(post).toContain("@KennixDev");
  });

  it("свои хэштеги автора не подменяются общими", () => {
    const post = withChannelSignature("текст\n\n———————\n#Разработка #Stars");

    expect(post).toContain("#Разработка #Stars");
    expect(post).not.toContain("#GameDev");
  });

  it("готовая закрывашка не дублируется", () => {
    const post = withChannelSignature("текст\n———————\n#Dev\n🚀 @KennixDev | 🙏 Поддержать");

    expect(post.match(/@KennixDev/g)).toHaveLength(1);
  });
});

describe("что и куда уходит", () => {
  const team = parseChatTarget("-1001234567890:57");

  it("адрес чата — id или id:тема, как у ADMIN_CHAT_* бэкенда", () => {
    expect(team).toEqual({ chatId: "-1001234567890", threadId: 57 });
    expect(parseChatTarget("-1001234567890")).toEqual({ chatId: "-1001234567890", threadId: null });
    expect(parseChatTarget("не чат")).toBeNull();
    expect(parseChatTarget(undefined)).toBeNull();
  });

  it("сводка уходит в чат команды", () => {
    const { messages } = plannedMessages(BODY, { team, drafts: null });

    expect(messages).toHaveLength(1);
    expect(messages[0].target).toEqual(team);
  });

  it("черновик поста — только в свою тему, в ленту команды он не идёт", () => {
    const drafts = parseChatTarget("-1001234567890:142");
    const body = `${BODY}\n\n## ${CHANNEL_SECTION}\n🎮 **ПОСТ**\n\nтекст`;

    const { messages } = plannedMessages(body, { team, drafts });
    const toDrafts = messages.filter((message: { target: unknown }) => message.target === drafts);

    expect(toDrafts.map((message: { text: string }) => message.text).join("\n")).toContain("Черновик поста");
    expect(toDrafts.at(-1).text).toContain("@KennixDev");
    // В ленту команды ушла только сводка — черновик её не засоряет.
    expect(messages.filter((message: { target: unknown }) => message.target === team)).toHaveLength(1);
  });

  it("без темы для черновиков пост не отправляется, и об этом сказано", () => {
    const body = `${BODY}\n\n## ${CHANNEL_SECTION}\n🎮 **ПОСТ**\n\nтекст`;

    const { messages, skipped } = plannedMessages(body, { team, drafts: null });

    expect(messages.every((message: { text: string }) => !message.text.includes("Черновик"))).toBe(true);
    expect(skipped.join(" ")).toContain("TEAM_TELEGRAM_DRAFTS_CHAT");
  });

  it("без чата не отправляет ничего, а не падает", () => {
    const { messages, skipped } = plannedMessages(BODY, { team: null, drafts: null });

    expect(messages).toEqual([]);
    expect(skipped.join(" ")).toContain("TEAM_TELEGRAM_CHAT");
  });
});

describe("PR по коммиту из push", () => {
  const sha = "abc123";

  it("находит PR, чьим мерджем стал коммит", () => {
    const merged = { number: 51, merged_at: "2026-09-23T10:00:00Z", merge_commit_sha: sha, body: "" };

    expect(pullRequestForPush(sha, [merged])).toBe(merged);
  });

  it("открытый релизный PR, куда коммит уже попал, — не тот", () => {
    // GitHub связывает коммит со всеми PR, где он есть: сводку прислал бы
    // релизный PR, а не тот, что его принёс.
    const release = { number: 60, merged_at: null, merge_commit_sha: null, body: "" };

    expect(pullRequestForPush(sha, [release])).toBeNull();
  });

  it("влитый PR с другим коммитом мерджа — тоже не тот", () => {
    const other = { number: 40, merged_at: "2026-09-20T10:00:00Z", merge_commit_sha: "другой", body: "" };

    expect(pullRequestForPush(sha, [other])).toBeNull();
  });

  it("перемотка синка без PR — отправлять нечего", () => {
    expect(pullRequestForPush(sha, [])).toBeNull();
  });
});

describe("нарезка по пределу Bot API", () => {
  it("короткое сообщение не режется", () => {
    expect(splitMessage("абзац", 100)).toEqual(["абзац"]);
  });

  it("режет по абзацам и не превышает предел", () => {
    const text = Array.from({ length: 10 }, (_, index) => `абзац ${index} ${"x".repeat(40)}`).join("\n\n");

    const parts = splitMessage(text, 120);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part: string) => part.length <= 120)).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
  });

  it("абзац длиннее предела режется, а не теряется", () => {
    const parts = splitMessage("y".repeat(250), 100);

    expect(parts.join("")).toBe("y".repeat(250));
  });
});
