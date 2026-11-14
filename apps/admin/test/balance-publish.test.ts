import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchCurrent, fetchPublication, mergeFromCode, publishDraft, rollbackTo, type CurrentPointers, type PublicationPreview, type VersionSummary } from "../src/api/content";
import { railSteps, type CheckOutcome, type CorridorLine, type Rails } from "../src/screens/balance/check/check-rules";
import { AUDIENCE_LABEL, dialogModel, historyRows, publishUi, resultText, rollbackText } from "../src/screens/balance/publish/publish-rules";
import { fakeFetch, json } from "./helpers";

// Публикация в «Балансе» (tasks/T-0306): кнопки «Команде» и «Всем» живут только
// при зелёных рельсах проверки, «История и откат» показывает, что в игре у какой
// аудитории, и откат доступен только для версий, которые в игре бывали.
// Логика без DOM.

const DODGING: CorridorLine = {
  id: "dodgingMedianSec",
  title: "Медиана уклоняющегося",
  corridor: { min: 180, max: 300 },
  baseCorridor: { min: 180, max: 300 },
  base: { value: 245, verdict: "in" },
  draft: { value: 220, verdict: "in" },
};

function outcome(corridors: CorridorLine[], extra: Partial<CheckOutcome> = {}): CheckOutcome {
  return { schemaProblems: [], contentProblems: [], report: { timeout: false, seeds: 20, scenarios: [], corridors }, ...extra };
}

const GREEN: Rails = railSteps({ outcome: outcome([DODGING]), status: "done", stale: false, running: false });
const STALE: Rails = railSteps({ outcome: outcome([DODGING]), status: "done", stale: true, running: false });
const RED: Rails = railSteps({ outcome: outcome([{ ...DODGING, draft: { value: 150, verdict: "below" } }]), status: "done", stale: false, running: false });
const EMPTY: Rails = railSteps({ outcome: null, status: null, stale: false, running: false });
const RUNNING: Rails = railSteps({ outcome: null, status: "queued", stale: false, running: true });

const base = { canPublish: true, narrow: false, hasDraft: true, busy: false };

describe("кнопки «Команде» и «Всем»: живут только при зелёных рельсах", () => {
  it("зелёные рельсы — обе кнопки доступны", () => {
    const ui = publishUi({ ...base, rails: GREEN });
    expect(ui.visible).toBe(true);
    expect(ui.team).toEqual({ enabled: true, hint: null });
    expect(ui.all).toEqual({ enabled: true, hint: null });
  });

  it("красные, устаревшие, пустые и идущие рельсы — кнопки видны, но недоступны, с причиной", () => {
    for (const rails of [RED, STALE, EMPTY, RUNNING]) {
      const ui = publishUi({ ...base, rails });
      expect(ui.visible).toBe(true);
      expect(ui.team.enabled).toBe(false);
      expect(ui.all.enabled).toBe(false);
      expect(ui.team.hint).not.toBeNull();
    }
    expect(publishUi({ ...base, rails: STALE }).all.hint).toContain("устарел");
    expect(publishUi({ ...base, rails: RED }).all.hint).toContain("Проверк");
    expect(publishUi({ ...base, rails: RUNNING }).all.hint).toContain("идёт");
  });

  it("ключ проверки выключен — кнопки не ждут рельсов: иначе обход, ради которого ключ выключают, из панели недоступен", () => {
    for (const rails of [RED, STALE, EMPTY, RUNNING]) {
      const ui = publishUi({ ...base, rails, requireCheck: false });
      expect(ui.team).toEqual({ enabled: true, hint: null });
      expect(ui.all).toEqual({ enabled: true, hint: null });
    }
    // а право, черновик, телефон и идущая публикация по-прежнему решают
    expect(publishUi({ ...base, rails: RED, requireCheck: false, canPublish: false }).visible).toBe(false);
    expect(publishUi({ ...base, rails: RED, requireCheck: false, busy: true }).all.enabled).toBe(false);
    // ключ включён явно — как по умолчанию
    expect(publishUi({ ...base, rails: RED, requireCheck: true }).all.enabled).toBe(false);
  });

  it("пока публикация идёт, повторное нажатие невозможно", () => {
    const ui = publishUi({ ...base, rails: GREEN, busy: true });
    expect(ui.team.enabled).toBe(false);
    expect(ui.all.enabled).toBe(false);
  });

  it("без права content.publish, без черновика и на телефоне кнопок нет вовсе", () => {
    expect(publishUi({ ...base, rails: GREEN, canPublish: false }).visible).toBe(false);
    expect(publishUi({ ...base, rails: GREEN, hasDraft: false }).visible).toBe(false);
    expect(publishUi({ ...base, rails: GREEN, narrow: true }).visible).toBe(false);
  });
});

function version(no: number, extra: Partial<VersionSummary> = {}): VersionSummary {
  return {
    versionNo: no,
    contentHash: `hash${String(no)}`,
    schemaVersion: 1,
    source: "panel",
    createdBy: "me",
    createdAt: `2026-10-2${String(no)}T10:00:00.000Z`,
    publishedAt: `2026-10-2${String(no)}T10:05:00.000Z`,
    ...extra,
  };
}
const pointer = (versionNo: number) => ({ versionNo, setBy: "me", setAt: "2026-10-25T10:00:00.000Z" });
const rows = { canPublish: true, canEdit: true, hasDraft: true, meId: "me" };

describe("«История и откат»", () => {
  const versions = [version(1, { source: "repo", createdBy: null }), version(2), version(3), version(4, { source: "repo", createdBy: null, publishedAt: null })];

  it("версии идут новыми сверху; у каждой видно, у какой аудитории она в игре", () => {
    const history = historyRows({ ...rows, versions, current: { team: pointer(3), all: pointer(2) } });
    expect(history.map((row) => row.versionNo)).toEqual([4, 3, 2, 1]);
    expect(history.find((row) => row.versionNo === 3)?.live).toEqual(["team"]);
    expect(history.find((row) => row.versionNo === 2)?.live).toEqual(["all"]);
    expect(history.find((row) => row.versionNo === 1)?.live).toEqual([]);
  });

  it("версия у обеих аудиторий помечена обеими; без указателя команды она идёт за «всеми»", () => {
    const both = historyRows({ ...rows, versions, current: { team: pointer(3), all: pointer(3) } });
    expect(both.find((row) => row.versionNo === 3)?.live).toEqual(["team", "all"]);
    const follows = historyRows({ ...rows, versions, current: { team: null, all: pointer(2) } });
    expect(follows.find((row) => row.versionNo === 2)?.live).toEqual(["team", "all"]);
  });

  it("откат — на опубликованную версию, которая у аудитории сейчас не в игре", () => {
    const history = historyRows({ ...rows, versions, current: { team: pointer(3), all: pointer(2) } });
    expect(history.find((row) => row.versionNo === 3)?.rollbackTo).toEqual(["all"]);
    expect(history.find((row) => row.versionNo === 2)?.rollbackTo).toEqual(["team"]);
    // версия 1 была в игре до панели (published), версия 4 из кода и не публиковалась — на неё откатиться нельзя
    expect(history.find((row) => row.versionNo === 1)?.rollbackTo).toEqual(["team", "all"]);
    expect(history.find((row) => row.versionNo === 4)?.rollbackTo).toEqual([]);
  });

  it("без права content.publish откат не предлагается; «Всем» без публикаций откатывать не с чего", () => {
    const noRight = historyRows({ ...rows, canPublish: false, versions, current: { team: pointer(3), all: pointer(2) } });
    expect(noRight.every((row) => row.rollbackTo.length === 0)).toBe(true);
    const nothingPublished = historyRows({ ...rows, versions, current: { team: null, all: null } });
    expect(nothingPublished.every((row) => !row.rollbackTo.includes("all"))).toBe(true);
  });

  it("новая версия из кода, ждущая рядом, — «из кода — новое понятие» и «Взять из кода»; старая ждущая — просто «из кода»", () => {
    const waiting = [...versions, version(5, { source: "repo", createdBy: null, publishedAt: null })];
    const history = historyRows({ ...rows, versions: waiting, current: { team: pointer(3), all: pointer(3) } });
    const newest = history.find((row) => row.versionNo === 5);
    expect(newest).toMatchObject({ takeFromCode: true, note: "из кода — новое понятие" });
    const older = history.find((row) => row.versionNo === 4);
    expect(older?.takeFromCode).toBe(false);
    expect(older?.note).toBe("из кода");
    expect(history.find((row) => row.versionNo === 3)?.takeFromCode).toBe(false);
  });

  it("«Взять из кода» нужен право правки и открытый черновик", () => {
    const waiting = [version(1), version(2, { source: "repo", createdBy: null, publishedAt: null })];
    const current = { team: pointer(1), all: pointer(1) };
    expect(historyRows({ ...rows, versions: waiting, current }).find((row) => row.versionNo === 2)?.takeFromCode).toBe(true);
    expect(historyRows({ ...rows, canEdit: false, versions: waiting, current }).find((row) => row.versionNo === 2)?.takeFromCode).toBe(false);
    expect(historyRows({ ...rows, hasDraft: false, versions: waiting, current }).find((row) => row.versionNo === 2)?.takeFromCode).toBe(false);
  });

  it("автор — «вы», «из кода» или начало номера аккаунта; дата — публикации, а без неё создания", () => {
    const history = historyRows({
      ...rows,
      versions: [version(1, { source: "repo", createdBy: null }), version(2, { createdBy: "someone-else-1234" }), version(3), version(4, { source: "repo", createdBy: null, publishedAt: null })],
      current: { team: pointer(3), all: pointer(3) },
    });
    expect(history.find((row) => row.versionNo === 1)?.author).toBe("из кода");
    expect(history.find((row) => row.versionNo === 2)?.author).toBe("№someone-");
    expect(history.find((row) => row.versionNo === 3)?.author).toBe("вы");
    expect(history.find((row) => row.versionNo === 3)?.date).toBe("2026-10-23T10:05:00.000Z");
    expect(history.find((row) => row.versionNo === 4)?.date).toBe("2026-10-24T10:00:00.000Z");
  });
});

function preview(extra: Partial<PublicationPreview> = {}): PublicationPreview {
  return { audience: "all", liveVersionNo: 7, alreadyLive: false, onTeam: true, ready: true, reason: null, changes: [{ path: "enemies[id=a].hp", from: 5, to: 7 }], truncated: false, ...extra };
}

describe("окно «Всем»", () => {
  it("готово: подтверждать можно, правки считаются против версии в игре", () => {
    const model = dialogModel(preview());
    expect(model.canConfirm).toBe(true);
    expect(model.title).toBe("Опубликовать всем?");
    expect(model.summary).toContain("v7");
    expect(model.warnings).toEqual([]);
  });

  it("версию команда не смотрела — предупреждение, но публиковать можно", () => {
    const model = dialogModel(preview({ onTeam: false }));
    expect(model.canConfirm).toBe(true);
    expect(model.warnings.join(" ")).toContain("команда ещё не смотрела");
  });

  it("версия уже в игре у всех — подтверждать нечего", () => {
    const model = dialogModel(preview({ alreadyLive: true, changes: [] }));
    expect(model.canConfirm).toBe(false);
    expect(model.warnings.join(" ")).toContain("уже в игре");
  });

  it("сервер не готов публиковать — причина сервера, подтверждения нет", () => {
    const model = dialogModel(preview({ ready: false, reason: "Черновик менялся после проверки" }));
    expect(model.canConfirm).toBe(false);
    expect(model.warnings).toContain("Черновик менялся после проверки");
  });

  it("правок против версии в игре нет, но версия не та же — это возврат к старому, и это названо", () => {
    const model = dialogModel(preview({ changes: [] }));
    expect(model.summary).toContain("не отличается");
  });

  it("аудитории названы словами игры", () => {
    expect(AUDIENCE_LABEL).toEqual({ team: "Команде", all: "Всем" });
  });

  it("итоги: публикация, повтор без изменений, откат", () => {
    expect(resultText("all", { versionNo: 9, created: true, changed: true })).toBe("Опубликована v9 для всех");
    expect(resultText("team", { versionNo: 9, created: false, changed: true })).toBe("v9 теперь у команды");
    expect(resultText("all", { versionNo: 9, created: false, changed: false })).toBe("v9 уже в игре у всех — ничего не изменилось");
    expect(rollbackText("all", { versionNo: 6, changed: true })).toBe("Откат: у всех снова v6");
    expect(rollbackText("team", { versionNo: 6, changed: false })).toBe("v6 уже у команды — ничего не изменилось");
  });
});

const POINTERS: CurrentPointers = { team: pointer(3), all: pointer(2) };

describe("запросы публикации", () => {
  it("указатели — GET /current", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: POINTERS }));
    const result = await fetchCurrent(new AdminApi(fetch));
    expect(result.ok && result.data.team?.versionNo).toBe(3);
    expect(calls[0]?.url).toContain("/content/current");
  });

  it("пустые указатели — null у аудитории, а не ошибка; ключ проверки по умолчанию включён", async () => {
    const { fetch } = fakeFetch(json(200, { data: { team: null, all: null } }));
    const result = await fetchCurrent(new AdminApi(fetch));
    expect(result.ok && result.data).toEqual({ team: null, all: null, requireCheck: true });
  });

  it("ключ content.publish-require-check приходит вместе с указателями", async () => {
    const { fetch } = fakeFetch(json(200, { data: { ...POINTERS, requireCheck: false } }));
    const result = await fetchCurrent(new AdminApi(fetch));
    expect(result.ok && result.data.requireCheck).toBe(false);
  });

  it("предпросмотр — GET /drafts/:id/publication?audience=", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: preview() }));
    const result = await fetchPublication(new AdminApi(fetch), "d1", "all");
    expect(result.ok && result.data.liveVersionNo).toBe(7);
    expect(calls[0]?.url).toContain("/content/drafts/d1/publication");
    expect(calls[0]?.url).toContain("audience=all");
  });

  it("публикация — POST /drafts/:id/publish с аудиторией", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: { audience: "team", versionNo: 9, contentHash: "h", created: true, changed: true, previousVersionNo: 8 } }));
    const result = await publishDraft(new AdminApi(fetch), "d1", "team");
    expect(result.ok && result.data.versionNo).toBe(9);
    expect(calls[0]?.url).toContain("/content/drafts/d1/publish");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ audience: "team" });
  });

  it("отказ «нужна проверка» приходит причиной сервера, а не общей ошибкой", async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: "content_check_required", message: "Черновик менялся после проверки — запустите «Проверить» снова" } }));
    const result = await publishDraft(new AdminApi(fetch), "d1", "all");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("content_check_required");
      expect(result.error.message).toContain("менялся после проверки");
    }
  });

  it("откат — POST /rollback с аудиторией и номером версии", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: { audience: "all", versionNo: 6, previousVersionNo: 7, changed: true } }));
    const result = await rollbackTo(new AdminApi(fetch), "all", 6);
    expect(result.ok && result.data.versionNo).toBe(6);
    expect(calls[0]?.url).toContain("/content/rollback");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ audience: "all", versionNo: 6 });
  });

  it("«Взять из кода» — POST /drafts/:id/merge-code с номером версии", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: { baseVersionNo: 5, fromVersionNo: 5, added: 3, changed: true, snapshotHash: "h" } }));
    const result = await mergeFromCode(new AdminApi(fetch), "d1", 5);
    expect(result.ok && result.data.added).toBe(3);
    expect(calls[0]?.url).toContain("/content/drafts/d1/merge-code");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ versionNo: 5 });
  });
});
