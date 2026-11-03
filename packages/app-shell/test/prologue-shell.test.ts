import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { RunProfile, RunResult, UpgradeOption } from "@bh/shared-types";
import { t } from "../src/i18n";
import "../src/i18n/run";
import { PrologueWinView } from "../src/screens/run/PrologueWin";
import { LevelUpOverlay } from "../src/screens/run/overlays";
import { HINT_ORDER, hintsSeenFor, nextHint, type HintSignals } from "../src/state/hints";
import type { HistoryEntry } from "../src/state/history-api";
import { useMeta } from "../src/state/meta";
import {
  acknowledged,
  difficultyForMode,
  homeFace,
  prologueRewardOf,
  resolvePrologue,
  sectionsOpenFor,
  shouldPlayPrologue,
  usePrologue,
  type FreshMarks,
} from "../src/state/prologue";
import { toStart, toSubmission, useRuns } from "../src/state/runs";
import { useSession } from "../src/state/session";

// Пролог в оболочке (tasks/T-0280, Р151): первый запуск без меню, подсказки по
// событию, «Советуем», окно «Рубеж удержан!», разделы открываются победой.

const originalLoadProfile = useRuns.getState().loadProfile;

function profile(prologueDone: boolean | undefined): RunProfile {
  return { runs: 0, totalKills: 0, totalSurvivalSec: 0, best: { easy: null, normal: null, hard: null }, recent: [], ...(prologueDone === undefined ? {} : { prologueDone }) };
}

afterEach(() => {
  useMeta.setState({ runs: 0 });
  useRuns.setState({ profile: null, loadProfile: originalLoadProfile });
  useSession.setState({ status: "idle" });
  usePrologue.setState({ wonLocal: false, fresh: { daily: false, tasks: false, play: false } });
});

describe("правило запуска: пролог или обычный забег", () => {
  it("профиль сказал, что пролог не пройден, — пролог, сколько бы забегов ни было", () => {
    expect(shouldPlayPrologue({ prologueDone: false, runs: 0 })).toBe(true);
    expect(shouldPlayPrologue({ prologueDone: false, runs: 7 })).toBe(true);
  });

  it("пролог пройден — обычный забег, даже если на устройстве забегов нет", () => {
    expect(shouldPlayPrologue({ prologueDone: true, runs: 0 })).toBe(false);
    expect(shouldPlayPrologue({ prologueDone: true, runs: 3 })).toBe(false);
  });

  it("профиль не пришёл: нет забегов — пролог, есть — обычный", () => {
    expect(shouldPlayPrologue({ prologueDone: null, runs: 0 })).toBe(true);
    expect(shouldPlayPrologue({ prologueDone: null, runs: 2 })).toBe(false);
  });

  it("сложность: пролог — «лёгкая», остальное — единая; правило «забегов нет — лёгкая» заменено", () => {
    expect(difficultyForMode("prologue")).toBe("easy");
    expect(difficultyForMode("endless")).toBe("hard");
  });

  it("профиль уже загружен — спрашивать сервер не нужно", async () => {
    useRuns.setState({
      profile: profile(false),
      loadProfile: async () => {
        throw new Error("лишний запрос");
      },
    });
    expect(await resolvePrologue()).toBe(true);
    useRuns.setState({ profile: profile(true) });
    expect(await resolvePrologue()).toBe(false);
  });

  it("профиля нет — ждёт его недолго и решает по ответу", async () => {
    useSession.setState({ status: "ready" });
    useRuns.setState({
      loadProfile: async () => {
        useRuns.setState({ profile: profile(false) });
        return null;
      },
    });
    expect(await resolvePrologue()).toBe(true);
  });

  it("профиль не пришёл за отведённое время: по числу забегов на устройстве", async () => {
    useSession.setState({ status: "ready" });
    useRuns.setState({ loadProfile: () => new Promise(() => undefined) });
    expect(await resolvePrologue({ timeoutMs: 30 })).toBe(true);

    useMeta.setState({ runs: 4 });
    expect(await resolvePrologue({ timeoutMs: 30 })).toBe(false);
  });

  it("сессии нет вовсе — не ждём: нет забегов — пролог", async () => {
    useSession.setState({ status: "failed" });
    expect(await resolvePrologue()).toBe(true);
  });
});

describe("подсказки в прологе — по одной, по событию", () => {
  const none: HintSignals = { gem: false, levelUp: false, elite: false };

  it("порядок: движение, кристаллы, выбор, элита", () => {
    expect([...HINT_ORDER]).toEqual(["move", "gems", "choose", "dodge"]);
  });

  it("на старте — только про движение, остальные ждут своего события", () => {
    expect(nextHint({ seen: [], signals: none })).toBe("move");
    // Кристалл упал, но игрок ещё не пошёл: сначала управление.
    expect(nextHint({ seen: [], signals: { ...none, gem: true } })).toBe("move");
  });

  it("кристаллы — с первым кристаллом на поле, выбор — с первым выбором, элита — с первой элитой", () => {
    expect(nextHint({ seen: ["move"], signals: none })).toBeNull();
    expect(nextHint({ seen: ["move"], signals: { ...none, gem: true } })).toBe("gems");
    expect(nextHint({ seen: ["move", "gems"], signals: { ...none, gem: true } })).toBeNull();
    expect(nextHint({ seen: ["move", "gems"], signals: { gem: true, levelUp: true, elite: false } })).toBe("choose");
    expect(nextHint({ seen: ["move", "gems", "choose"], signals: { gem: true, levelUp: true, elite: false } })).toBeNull();
    expect(nextHint({ seen: ["move", "gems", "choose"], signals: { gem: true, levelUp: true, elite: true } })).toBe("dodge");
  });

  it("показано всё — больше подсказок нет", () => {
    expect(nextHint({ seen: [...HINT_ORDER], signals: { gem: true, levelUp: true, elite: true } })).toBeNull();
  });

  it("в прологе виденное на устройстве не в счёт — подсказки идут заново; вне пролога — как прежде", () => {
    const onDevice = ["move", "gems", "dodge"] as const;
    expect(hintsSeenFor({ prologue: true, device: onDevice, session: [] })).toEqual([]);
    expect(hintsSeenFor({ prologue: true, device: onDevice, session: ["move"] })).toEqual(["move"]);
    expect(hintsSeenFor({ prologue: false, device: onDevice, session: [] })).toEqual(onDevice);
  });
});

describe("разделы и главная до и после победы", () => {
  const marks: FreshMarks = { daily: true, tasks: true, play: true };

  it("пока пролог не пройден — разделы закрыты; победа или профиль «пройден» открывают", () => {
    expect(sectionsOpenFor({ prologueDone: false, runs: 0, wonLocal: false })).toBe(false);
    expect(sectionsOpenFor({ prologueDone: null, runs: 0, wonLocal: false })).toBe(false);
    expect(sectionsOpenFor({ prologueDone: true, runs: 0, wonLocal: false })).toBe(true);
    expect(sectionsOpenFor({ prologueDone: null, runs: 5, wonLocal: false })).toBe(true);
    // Победа только что случилась, профиль ещё не обновился.
    expect(sectionsOpenFor({ prologueDone: false, runs: 0, wonLocal: true })).toBe(true);
  });

  it("до победы — только «Играть» и строка «Первый бой — три минуты»", () => {
    const face = homeFace({ open: false, fresh: marks });
    expect(face.sections).toBe(false);
    expect(face.line).toBe("first");
    expect(face.marks).toEqual({ daily: false, tasks: false });
  });

  it("после победы — виджеты на месте, «Новое» у награды дня и заданий, подпись у «Играть»", () => {
    const face = homeFace({ open: true, fresh: marks });
    expect(face.sections).toBe(true);
    expect(face.line).toBe("endless");
    expect(face.marks).toEqual({ daily: true, tasks: true });
  });

  it("у старого аккаунта пролога не было — ни «Нового», ни подписи", () => {
    const face = homeFace({ open: true, fresh: { daily: false, tasks: false, play: false } });
    expect(face).toEqual({ sections: true, line: null, marks: { daily: false, tasks: false } });
  });

  it("«Новое» гаснет первым открытием раздела, второй раздел остаётся", () => {
    const next = acknowledged(marks, "daily");
    expect(next).toEqual({ daily: false, tasks: true, play: true });
    expect(acknowledged(next, "tasks")).toEqual({ daily: false, tasks: false, play: true });
  });

  it("победа заводит метки, первое открытие гасит, начало второго забега убирает подпись", () => {
    usePrologue.getState().markWon();
    expect(usePrologue.getState().wonLocal).toBe(true);
    expect(usePrologue.getState().fresh).toEqual({ daily: true, tasks: true, play: true });

    usePrologue.getState().acknowledge("tasks");
    expect(usePrologue.getState().fresh).toEqual({ daily: true, tasks: false, play: true });

    usePrologue.getState().endlessRunStarted();
    expect(usePrologue.getState().fresh.play).toBe(false);
  });

  it("профиль подтвердил «пройден» — местная отметка победы больше не нужна; отверг при пустой очереди — снимается", () => {
    usePrologue.getState().markWon();
    usePrologue.getState().reconcile({ prologueDone: false, pending: 1 });
    expect(usePrologue.getState().wonLocal).toBe(true);
    usePrologue.getState().reconcile({ prologueDone: false, pending: 0 });
    expect(usePrologue.getState().wonLocal).toBe(false);
  });
});

describe("окно «Рубеж удержан!»", () => {
  const result = {
    runId: "run-1",
    seed: 7,
    outcome: "abandoned",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "easy",
    contentHash: "abc",
    waveReached: 6,
    survivalSec: 184,
    level: 12,
    xpCollected: 400,
    enemiesKilled: 220,
    killsByEnemy: {},
    damageDealt: 9000,
    damageTaken: 120,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 1,
    eliteKills: 1,
    chestsOpened: 2,
    crystalsCollected: 300,
    weapons: [{ id: "spark", level: 4, damage: 9000 }],
    passives: [],
    deathCause: null,
    distance: 4000,
    peakEnemies: 70,
    cheats: false,
    continues: [],
    mode: "prologue",
    prologue: { won: true, sec: 184 },
  } as unknown as RunResult;

  const render = (reward: Parameters<typeof PrologueWinView>[0]["reward"]): string =>
    renderToStaticMarkup(createElement(PrologueWinView, { result, reward, onHome: () => undefined }));

  it("заголовок, время забега, строка про открытые разделы, цель и кнопка", () => {
    const html = render({ status: "pending" });
    expect(html).toContain("Рубеж удержан!");
    expect(html).toContain("3:04");
    expect(html).toContain("Открыты Награда дня и Задания");
    expect(html).toContain("На 10-м уровне — облик Знахарки");
    expect(html).toContain("На главную");
  });

  it("числа награды — из ответа сервера, а не постоянные", () => {
    const html = render({ status: "granted", coins: 640, gems: 12 });
    expect(html).toContain("+640");
    expect(html).toContain("+12");
    expect(html).not.toContain("+500");
    expect(html).not.toContain("+10<");
  });

  it("нулевая часть награды не рисуется (панель вправе обнулить)", () => {
    const html = render({ status: "granted", coins: 500, gems: 0 });
    expect(html).toContain("+500");
    expect(html).not.toContain("+0");
  });

  it("нет сети при записи забега — награда придёт, когда вернётся связь", () => {
    const html = render({ status: "offline" });
    expect(html).toContain("придёт, когда вернётся связь");
    expect(html).not.toContain("+500");
  });

  it("награду берёт из истории кошелька по причине prologue_reward; чужие записи не считаются", () => {
    const wallet = (resource: string, amount: number, reason: string): HistoryEntry => ({ id: `${resource}-${reason}`, at: "2026-11-03T10:00:00Z", category: "currency", kind: "wallet", resource, amount, reason });
    expect(prologueRewardOf([wallet("coins", 40, "run_reward"), wallet("coins", 500, "prologue_reward"), wallet("gems", 10, "prologue_reward")])).toEqual({ coins: 500, gems: 10 });
    expect(prologueRewardOf([wallet("coins", 40, "run_reward")])).toBeNull();
    expect(prologueRewardOf([])).toBeNull();
  });
});

describe("запись пролога на сервер", () => {
  const base = {
    runId: "run-9",
    seed: 1,
    outcome: "abandoned",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "easy",
    contentHash: "abc",
    waveReached: 6,
    survivalSec: 184,
    level: 12,
    xpCollected: 1,
    enemiesKilled: 10,
    killsByEnemy: {},
    damageDealt: 1,
    damageTaken: 1,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    crystalsCollected: 0,
    weapons: [],
    passives: [],
    deathCause: null,
    distance: 1,
    peakEnemies: 1,
    cheats: false,
    continues: [],
  } as unknown as RunResult;

  it("итог несёт режим и победу — без них сервер не выдал бы награду", () => {
    const body = toSubmission({ ...base, mode: "prologue", prologue: { won: true, sec: 184 } });
    expect(body.mode).toBe("prologue");
    expect(body.prologue).toEqual({ won: true, sec: 184 });
  });

  it("у обычного забега режима и пролога в теле нет", () => {
    const body = toSubmission(base);
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("prologue");
  });

  it("старт пролога несёт режим", () => {
    const start = { kind: "start" as const, runId: "r", difficultyId: "easy" as const, startingWeaponId: "spark", contentHash: "h", startedAtMs: 0, mode: "prologue" as const };
    expect(toStart(start, 1000).mode).toBe("prologue");
    expect(toStart({ ...start, mode: undefined }, 1000)).not.toHaveProperty("mode");
  });

  it("сданный до победы пролог не считается сыгранным забегом; победа — считается, рекорда не ставит", () => {
    useMeta.setState({ runs: 0 });
    expect(useMeta.getState().submitRun({ ...base, mode: "prologue", prologue: { won: false, sec: 40 } })).toBe(false);
    expect(useMeta.getState().runs).toBe(0);
    expect(useMeta.getState().submitRun({ ...base, mode: "prologue", prologue: { won: true, sec: 184 } })).toBe(false);
    expect(useMeta.getState().runs).toBe(1);
  });
});

describe("«Советуем» и тексты пролога", () => {
  const offer = (id: string, recommended: boolean): UpgradeOption => ({
    id,
    kind: "weapon_new",
    refId: "spark",
    level: 1,
    nameKey: "weapon.spark.name",
    descriptionKey: "weapon.spark.description",
    ...(recommended ? { recommended: true } : {}),
    changes: [],
  });

  it("метка «Советуем» — только у карточки с recommended", () => {
    const withMark = renderToStaticMarkup(
      createElement(LevelUpOverlay, { level: 2, offers: [offer("a", true), offer("b", false), offer("c", false)], queued: 0, onChoose: () => undefined }),
    );
    // Метка на одной карточке; ещё раз слово встречается в подсказке под карточками.
    expect(withMark.match(/data-recommended/g)?.length).toBe(1);
    expect(withMark).toContain("Выбери улучшение — «Советуем» подойдёт для начала");

    const plain = renderToStaticMarkup(
      createElement(LevelUpOverlay, { level: 2, offers: [offer("a", false), offer("b", false)], queued: 0, onChoose: () => undefined }),
    );
    expect(plain).not.toContain("Советуем");
  });

  it("тексты — дословно по спецификации", () => {
    expect(t("run.prologue.intro")).toBe("Навь идёт к рубежу. Держи его");
    expect(t("run.hint.choose")).toBe("Выбери улучшение — «Советуем» подойдёт для начала");
    expect(t("run.hint.dodge.prologue")).toBe("Золотая кайма — элита: бьёт больнее. Держись на расстоянии — с неё упадёт сундук");
    expect(t("run.hint.ward")).toBe("Оберег не даст пасть в первом бою");
    expect(t("run.levelUp.recommended")).toBe("Советуем");
    expect(t("run.prologue.title")).toBe("Рубеж удержан!");
    expect(t("run.prologue.opened")).toBe("Открыты Награда дня и Задания");
    expect(t("run.prologue.goal")).toBe("На 10-м уровне — облик Знахарки");
    expect(t("run.prologue.home")).toBe("На главную");
    expect(t("run.surrender.prologue")).toBe("Пролог можно пройти позже — он начнётся заново");
    expect(t("lobby.prologue.first")).toBe("Первый бой — три минуты");
    expect(t("lobby.prologue.next")).toBe("Дальше — бесконечный рубеж: сколько продержишься?");
    expect(t("lobby.new")).toBe("Новое");
  });
});
