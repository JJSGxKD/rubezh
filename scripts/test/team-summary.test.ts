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
  teamUsernames,
  toTelegramHtml,
  withChannelSignature,
  withMentions,
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

describe("подпись генератора в конце описания", () => {
  // Агент дописывает подпись последней строкой описания, а по шаблону
  // последние разделы — сводка и пост. Без обрезки подпись уезжает в чат
  // команды и в черновик для публичного канала (так было в PR #51).
  const SIGNATURE = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
  const TEAM = `## ${TEAM_SECTION}\n📋 **СВОДКА**\n\nтекст сводки`;
  const CHANNEL = `## ${CHANNEL_SECTION}\n🎮 **ПОСТ**\n\nтекст поста`;

  it("отрезается от сводки, если она последний раздел", () => {
    expect(extractSection(`${TEAM}\n\n${SIGNATURE}\n`, TEAM_SECTION)).toBe("📋 **СВОДКА**\n\nтекст сводки");
  });

  it("отрезается от поста в канал, если он последний раздел", () => {
    expect(extractSection(`${TEAM}\n\n${CHANNEL}\n\n${SIGNATURE}`, CHANNEL_SECTION)).toBe("🎮 **ПОСТ**\n\nтекст поста");
  });

  it("не доходит ни до чата команды, ни до черновика", () => {
    const team = parseChatTarget("-1001234567890:57");
    const drafts = parseChatTarget("-1001234567890:142");

    const { messages } = plannedMessages(`${TEAM}\n\n${CHANNEL}\n\n${SIGNATURE}`, { team, drafts });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message: { text: string }) => !message.text.includes("Generated with"))).toBe(true);
  });

  it("черта перед подписью уходит вместе с ней", () => {
    expect(extractSection(`${TEAM}\n\n---\n\n${SIGNATURE}`, TEAM_SECTION)).toBe("📋 **СВОДКА**\n\nтекст сводки");
  });

  it("раздел без подписи не меняется, даже с чертой в конце: черта сама по себе не подпись", () => {
    expect(extractSection(`${TEAM}\n\n---`, TEAM_SECTION)).toBe("📋 **СВОДКА**\n\nтекст сводки\n\n---");
    expect(extractSection(BODY, TEAM_SECTION)).toBe("📋 **СВОДКА: В DEV ВЛИТ PR #50**\n\nКороткое вступление.\n\n🔐 **Раздел**\n\nТекст с `кодом`.");
  });

  it("раздел не последний — подпись в конце описания его не задевает", () => {
    const body = `${TEAM}\n\n${CHANNEL}\n\n${SIGNATURE}`;

    expect(extractSection(body, TEAM_SECTION)).toBe(extractSection(`${TEAM}\n\n${CHANNEL}`, TEAM_SECTION));
  });

  it("такая же строка посреди раздела остаётся: отрезается только хвост", () => {
    const section = extractSection(`${TEAM}\n\n${SIGNATURE}\n\nпоследний абзац`, TEAM_SECTION);

    expect(section).toContain(SIGNATURE);
    expect(section?.endsWith("последний абзац")).toBe(true);
  });

  it("раздел из одной подписи — пустой: забытый в шаблоне пост не уходит черновиком", () => {
    const body = `${TEAM}\n\n## ${CHANNEL_SECTION}\n<!-- не нужен — удалить раздел -->\n\n${SIGNATURE}`;

    expect(extractSection(body, CHANNEL_SECTION)).toBeNull();
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

    const { messages, warnings } = plannedMessages(body, { team, drafts: null });

    expect(messages.every((message: { text: string }) => !message.text.includes("Черновик"))).toBe(true);
    expect(warnings.join(" ")).toContain("TEAM_TELEGRAM_DRAFTS_CHAT");
  });

  it("без чата не отправляет ничего, а не падает", () => {
    const { messages, warnings } = plannedMessages(BODY, { team: null, drafts: null });

    expect(messages).toEqual([]);
    expect(warnings.join(" ")).toContain("TEAM_TELEGRAM_CHAT");
  });
});

describe("упоминания участников", () => {
  // Юзернеймы живут в секретах: репозиторий публичный. Главное здесь — чтобы
  // юзернейм не утёк туда, где его увидят посторонние, и чтобы ненастроенный
  // секрет не превращал сводку в «@участник1» без смысла.
  const usernames = { участник1: "lead_dev", участник3: "game_designer" };

  it("заглушка становится упоминанием", () => {
    expect(withMentions("@участник1, проверь на телефоне", usernames).text).toBe("@lead_dev, проверь на телефоне");
  });

  it("@команда зовёт всех, у кого задан юзернейм", () => {
    expect(withMentions("@команда — голосуем", usernames).text).toBe("@lead_dev @game_designer — голосуем");
  });

  it("юзернейм не задан — имя роли, и сказано, какого секрета не хватило", () => {
    const { text, missing } = withMentions("@Участник2, нужна проверка", usernames);

    expect(text).toBe("Участник 2, нужна проверка");
    expect(missing).toEqual(["TEAM_TELEGRAM_MEMBER_2"]);
  });

  it("внутри кода заглушка не трогается: там синтаксис описывают, а не зовут", () => {
    expect(withMentions("пишите <code>@участник1</code>", usernames).text).toBe("пишите <code>@участник1</code>");
  });

  it("похожее слово заглушкой не считается", () => {
    expect(withMentions("@участник12 и @командами", usernames).text).toBe("@участник12 и @командами");
  });

  it("юзернейм берётся с @ и без, а мусор отбрасывается без показа значения", () => {
    const { usernames: parsed, invalid } = teamUsernames({
      TEAM_TELEGRAM_MEMBER_1: "@lead_dev",
      TEAM_TELEGRAM_MEMBER_2: "https://t.me/partner",
      TEAM_TELEGRAM_MEMBER_3: " game_designer ",
    });

    expect(parsed).toEqual({ участник1: "lead_dev", участник3: "game_designer" });
    expect(invalid).toEqual(["TEAM_TELEGRAM_MEMBER_2"]);
  });

  it("в сводке — юзернеймы, в черновике поста — никогда: он уйдёт в публичный канал", () => {
    const team = parseChatTarget("-1001234567890:57");
    const drafts = parseChatTarget("-1001234567890:142");
    const body = `## ${TEAM_SECTION}\n📋 **СВОДКА**\n\n@участник1, проверь\n\n## ${CHANNEL_SECTION}\n🎮 **ПОСТ**\n\n@участник1 проверил`;

    const { messages } = plannedMessages(body, { team, drafts }, usernames);
    const text = (target: unknown) =>
      messages
        .filter((message: { target: unknown }) => message.target === target)
        .map((message: { text: string }) => message.text)
        .join("\n");

    expect(text(team)).toContain("@lead_dev, проверь");
    expect(text(drafts)).not.toContain("lead_dev");
    expect(text(drafts)).toContain("участник 1 проверил");
  });

  it("незаданный юзернейм в сводке — предупреждение в прогоне, а не молчание", () => {
    const body = `## ${TEAM_SECTION}\n📋 **СВОДКА**\n\n@участник2, проверь`;

    const { warnings } = plannedMessages(body, { team: parseChatTarget("-100123"), drafts: null }, usernames);

    expect(warnings.join(" ")).toContain("TEAM_TELEGRAM_MEMBER_2");
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
