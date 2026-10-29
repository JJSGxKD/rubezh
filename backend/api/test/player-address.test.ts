import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// К игроку — на «ты», везде (docs/35-stage4-plan.md, Р163; tasks/T-0332). Тест
// разбирает исходники компилятором TypeScript и проверяет только строковые
// литералы и куски шаблонных строк: комментарии, имена и логи (`logger.*` —
// текст команды, но его литералы тоже строки; такие места держи в TEAM_TEXTS)
// под проверку не попадают, пока не лежат в литерале.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Тексты команды, а не игрока: панель, инструменты, консоль и окружение сервера.
 * Путь — от `backend/api/src`, префикс каталога заканчивается на «/». Новый
 * файл с текстом для команды добавляется сюда, а не в обход теста.
 */
export const TEAM_PATHS: readonly string[] = [
  "modules/admin/",
  "modules/broadcasts/",
  "modules/export/",
  "modules/secrets/",
  "modules/settings/",
  "platforms/telegram/panel-login.command.ts",
  "platforms/telegram/role-confirm.command.ts",
  "cli/",
  "config/",
  "infra/",
  "health/",
  // вайп запускает команда; игроку из этой папки говорит только компенсация
  "modules/wipe/wipe-plan.ts",
  "modules/wipe/wipe-runner.ts",
  "modules/ads/ads-catalog.service.ts",
  "modules/ads/ad-networks.ts",
  "modules/ads/adsgram-reward.controller.ts",
  "modules/restrictions/restriction-rules.ts",
  "modules/media/image-rules.ts",
  "modules/media/media-errors.ts",
  "modules/promo-codes/promo-code-rules.ts",
  "modules/promo-codes/promo-codes.service.ts",
  "modules/changelog/changelog.service.ts",
  "modules/roles/tools.controller.ts",
  // уведомления в чат администраторов
  "modules/admin-notify/",
  // слоги имени, а не текст: «вы» — приставка
  "modules/auth/display-name-words.ts",
];

/**
 * Тексты команды внутри файлов игрока — поимённо, с кодом ошибки. Элемент —
 * кусок литерала, по которому его узнают; он должен встречаться в исходниках
 * (иначе исключение устарело, и тест называет его).
 */
export const TEAM_TEXTS: readonly { code: string; fragment: string }[] = [
  { code: "ad_block_shape_locked", fragment: "заведите новый блок, а этот выключите" },
  { code: "task_shape_locked", fragment: "заведите новое задание и выключите это" },
  { code: "promo_code_taken", fragment: "Придумайте другой" },
  { code: "purchase_undeliverable", fragment: "Верните звёзды" },
  { code: "fulfill_failed", fragment: "подробности в логе сервера" },
  { code: "promo_campaign_used", fragment: "поставьте на паузу" },
  { code: "team_slide_order_mismatch", fragment: "обновите страницу и переставьте ещё раз" },
  // ошибка разработчика: потолка начислений нет в коде
  { code: "wallet_cap_missing", fragment: "добавьте потолок в wallet-limits.ts" },
];

/** Существительные и формы, похожие на повелительное «-ите/-йте/-ьте», но им не являющиеся. */
export const NOT_PLURAL_IMPERATIVE: readonly string[] = ["элите", "орбите", "защите", "сайте"];

const YOU_PLURAL = /(?<![\p{L}\p{N}_])(?:вы|вас|вам|вами|ваш\p{L}*|\p{L}+(?:ите|йте|ьте)(?:сь)?)(?![\p{L}\p{N}_])/giu;

/** Слова обращения на «вы» в тексте; существительные из списка исключений не считаются. */
export function pluralAddressIn(text: string): string[] {
  return [...text.matchAll(YOU_PLURAL)].map((match) => match[0]).filter((word) => !NOT_PLURAL_IMPERATIVE.includes(word.toLowerCase()));
}

interface Literal {
  file: string;
  line: number;
  text: string;
}

/** Сгенерированный Prisma-клиент несёт в литералах всю схему с комментариями: текста для игрока там нет. */
const GENERATED_DIR = "generated";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (dir === SRC && name === GENERATED_DIR) return [];
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Строковые литералы и куски шаблонных строк файла с номерами строк. */
export function literalsOf(file: string, source: string): Literal[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const posix = (path: string): string => relative(SRC, path).split(sep).join("/");
const isTeamPath = (rel: string): boolean => TEAM_PATHS.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));

describe("игроку — на «ты»", () => {
  const files = walk(SRC);

  it("в текстах для игрока нет «вы», «вас», «вам», «ваш…» и повелительного на «-ите» / «-йте» / «-ьте»", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const rel = posix(path);
      if (isTeamPath(rel)) continue;
      for (const literal of literalsOf(rel, readFileSync(path, "utf8"))) {
        if (TEAM_TEXTS.some((entry) => literal.text.includes(entry.fragment))) continue;
        for (const word of pluralAddressIn(literal.text)) offenders.push(`${rel}:${String(literal.line)} — «${word}» в «${literal.text}»`);
      }
    }
    expect(offenders, `тексты игроку — на «ты» (Р163); текст команды — в TEAM_PATHS или TEAM_TEXTS:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("каждый путь из TEAM_PATHS существует — иначе исключение устарело", () => {
    const rels = files.map(posix);
    const stale = TEAM_PATHS.filter((entry) => !rels.some((rel) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry)));
    expect(stale, `пути исключений не найдены в исходниках: ${stale.join(", ")}`).toEqual([]);
  });

  it("каждый текст из TEAM_TEXTS встречается в исходниках — иначе исключение устарело", () => {
    const all = files.flatMap((path) => literalsOf(posix(path), readFileSync(path, "utf8"))).map((literal) => literal.text);
    const stale = TEAM_TEXTS.filter((entry) => !all.some((text) => text.includes(entry.fragment)));
    expect(stale.map((entry) => entry.code), "исключения, которых нет в исходниках").toEqual([]);
  });

  describe("сам детектор", () => {
    it("«попробуйте» ловится, «попробуй» и существительные — нет", () => {
      expect(pluralAddressIn("Слишком часто — попробуйте позже")).toEqual(["попробуйте"]);
      expect(pluralAddressIn("Слишком часто — попробуй позже")).toEqual([]);
      expect(pluralAddressIn("подпишитесь и нажми, постарайтесь")).toEqual(["подпишитесь", "постарайтесь"]);
      expect(pluralAddressIn("проверьте адрес, поставьте на паузу; проверь")).toEqual(["проверьте", "поставьте"]);
      expect(pluralAddressIn("враг на орбите")).toEqual([]);
      expect(pluralAddressIn("в элите и на сайте, при защите")).toEqual([]);
    });

    it("«вы», «вас», «вам», «ваш…» — целиком слова, внутри других слов не ловятся", () => {
      expect(pluralAddressIn("Вы получили награду")).toEqual(["Вы"]);
      expect(pluralAddressIn("зовёт вас, дарит вам, ваш аккаунт, вашего друга")).toEqual(["вас", "вам", "ваш", "вашего"]);
      expect(pluralAddressIn("вынос, вывод, увас")).toEqual([]);
    });

    it("шаблонные строки: кусок вокруг подстановки проверяется, имя в подстановке — нет", () => {
      const found = literalsOf("x.ts", "const a = `${name} зовёт вас в друзья`; const b = 'ok';");
      expect(found.flatMap((literal) => pluralAddressIn(literal.text))).toEqual(["вас"]);
    });

    it("комментарии и имена не проверяются", () => {
      const found = literalsOf("x.ts", "// попробуйте позже\nconst вас = 1; /* вам */");
      expect(found).toEqual([]);
    });
  });
});
