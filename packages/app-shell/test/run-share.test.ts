import { describe, expect, it } from "vitest";
import type { InvitePayload, InviteResult } from "@bh/shared-types";
import { runShareNote, runShareText, shareRunResult, type RunShareDeps } from "../src/state/run-share";

// «Поделиться» на экране итогов (docs/24-attribution-and-sharing.md §7): пока
// своей картинки результата нет, итог уходит путём приглашения друга —
// выбор чата со ссылкой и строкой о забеге. Молчащая кнопка читается как баг.

function deps(patch: Partial<RunShareDeps> = {}): RunShareDeps & { sent: InvitePayload[]; events: string[] } {
  const sent: InvitePayload[] = [];
  const events: string[] = [];
  return {
    sent,
    events,
    botUrl: "https://t.me/rubezh_bot/play",
    withAccount: true,
    link: async () => "friend-abc",
    invite: async (payload) => {
      sent.push(payload);
      return "shared";
    },
    track: (name, props) => events.push(`${name}:${String(props.result ?? props.method)}`),
    ...patch,
  };
}

describe("строка о забеге", () => {
  it("называет время, а рекорд — рекордом", () => {
    expect(runShareText({ survivalSec: 462, record: false })).toContain("7:42");
    expect(runShareText({ survivalSec: 462, record: true })).toMatch(/рекорд/i);
  });

  it("без рода: делится кто угодно", () => {
    expect(runShareText({ survivalSec: 90, record: false })).not.toMatch(/продержался|продержалась/i);
  });
});

describe("куда уходит итог", () => {
  it("со входом — ссылкой дружбы, как приглашение", async () => {
    const d = deps();
    await shareRunResult({ survivalSec: 462, record: false }, d);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]?.url).toBe("https://t.me/rubezh_bot/play?startapp=friend-abc");
    expect(d.sent[0]?.text).toContain("7:42");
  });

  it("без входа или без ссылки дружбы — просто ссылкой на игру", async () => {
    const guest = deps({ withAccount: false });
    await shareRunResult({ survivalSec: 60, record: false }, guest);
    expect(guest.sent[0]?.url).toBe("https://t.me/rubezh_bot/play");
    const noLink = deps({ link: async () => null });
    await shareRunResult({ survivalSec: 60, record: false }, noLink);
    expect(noLink.sent[0]?.url).toBe("https://t.me/rubezh_bot/play");
  });

  it("без бота делиться нечем — честно говорит, а не молчит", async () => {
    const d = deps({ botUrl: "" });
    const note = await shareRunResult({ survivalSec: 60, record: false }, d);
    expect(note).toBe(runShareNote("noBot"));
    expect(note).not.toBe(runShareNote("unavailable"));
    expect(d.sent).toHaveLength(0);
    expect(d.events).toHaveLength(0);
  });

  it("пишет предложение и итог в воронку шеринга", async () => {
    const d = deps({ invite: async (): Promise<InviteResult> => "copied" });
    await shareRunResult({ survivalSec: 60, record: false }, d);
    expect(d.events).toEqual(["share_offered:link", "share_completed:copied"]);
  });
});

describe("что сказать под кнопками", () => {
  it("открылся выбор чата или игрок закрыл его сам — ничего", () => {
    expect(runShareNote("shared")).toBeNull();
    expect(runShareNote("cancelled")).toBeNull();
  });

  it("скопировано или не вышло — строкой, а не ключом", () => {
    for (const outcome of ["copied", "unavailable", "noBot"] as const) {
      expect(runShareNote(outcome)).toMatch(/^[А-ЯЁ]/);
    }
  });
});
