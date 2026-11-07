import { describe, expect, it } from "vitest";
import { START_KINDS, parseStartParam } from "../src/modules/attribution/start-param.js";
import { newLinkCode } from "../src/modules/links/link-code.js";
import { NETWORK_PARAM_KEYS } from "../src/modules/links/link-networks.js";

// Параметр запуска (docs/34-stage3-plan.md, WP6): откуда пришёл игрок.
// Проверяется то, на чём разбор ломался в источнике переноса: мусор, чужой
// формат и склейка нескольких значений в одну строку.

describe("разбор параметра запуска", () => {
  it("нет параметра — органический запуск", () => {
    for (const value of [null, undefined, ""]) expect(parseStartParam(value)).toEqual({ kind: "organic", raw: null, ref: null });
  });

  it("узнаёт ссылку через редирект, приглашение друга и партнёрку Telegram", () => {
    expect(parseStartParam("c-Ab12Cd34")).toEqual({ kind: "click", raw: "c-Ab12Cd34", ref: "Ab12Cd34" });
    expect(parseStartParam("invite")).toEqual({ kind: "invite", raw: "invite", ref: null });
    expect(parseStartParam("_tgr_x9Y-z")).toEqual({ kind: "telegram_affiliate", raw: "_tgr_x9Y-z", ref: "x9Y-z" });
  });

  it("узнаёт прямую ссылку кампании l-<код>: вид «link», код — в ref", () => {
    expect(parseStartParam("l-AbC123")).toEqual({ kind: "link", raw: "l-AbC123", ref: "AbC123" });
    // Крайние длины кода ссылки: от шести до шестнадцати знаков.
    expect(parseStartParam("l-Ab12Cd")).toMatchObject({ kind: "link", ref: "Ab12Cd" });
    expect(parseStartParam("l-Ab12Cd34Ef56Gh78")).toMatchObject({ kind: "link", ref: "Ab12Cd34Ef56Gh78" });
  });

  it("код прямой ссылки проверяется правилом кода ссылки, второго правила нет", () => {
    // Выданный ссылке код всегда разбирается: правило и генератор не расходятся.
    const code = newLinkCode();
    expect(parseStartParam(`l-${code}`)).toEqual({ kind: "link", raw: `l-${code}`, ref: code });
    // Пустой, короткий, длинный или с дефисом внутри — не прямая ссылка, но сырая строка остаётся.
    for (const value of ["l-", "l-abc", "l-Ab12Cd34Ef56Gh78X", "l-abc-defgh"]) expect(parseStartParam(value), value).toEqual({ kind: "unknown", raw: value, ref: null });
    // Кириллицу Telegram в параметре не пропускает: даже сырой она не хранится.
    expect(parseStartParam("l-а1")).toEqual({ kind: "unknown", raw: null, ref: null });
  });

  it("клик c-<код> разбирается как раньше и с прямой ссылкой не путается", () => {
    expect(parseStartParam("c-Ab12Cd34")).toEqual({ kind: "click", raw: "c-Ab12Cd34", ref: "Ab12Cd34" });
    expect(parseStartParam("c-")).toMatchObject({ kind: "unknown", raw: "c-" });
    // Прямая ссылка — только строчная «l»: заглавная «L» — чужой формат.
    expect(parseStartParam("L-AbC123")).toMatchObject({ kind: "unknown" });
  });

  it("узнаёт ссылку дружбы по коду, а не по похожему началу", () => {
    expect(parseStartParam("f-Qw3rTy12Zx")).toEqual({ kind: "friend", raw: "f-Qw3rTy12Zx", ref: "Qw3rTy12Zx" });
    // Код короче восьми знаков или с дефисом внутри — не ссылка дружбы.
    expect(parseStartParam("f-abc")).toMatchObject({ kind: "unknown", raw: "f-abc" });
    expect(parseStartParam("f-abc-defgh")).toMatchObject({ kind: "unknown", raw: "f-abc-defgh" });
  });

  it("узнаёт кнопку уведомления в боте: вид — в ref", () => {
    expect(parseStartParam("n-friend_request")).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
    // Заглавные и цифры в виде не бывают — это чужой формат.
    expect(parseStartParam("n-Friend1")).toMatchObject({ kind: "unknown", raw: "n-Friend1" });
  });

  it("чужой формат не теряется: сырая строка остаётся для разбора потом", () => {
    expect(parseStartParam("r-123_source-channel")).toEqual({ kind: "unknown", raw: "r-123_source-channel", ref: null });
    // Похоже на клик, но код не той длины — не клик.
    expect(parseStartParam("c-abc")).toMatchObject({ kind: "unknown", raw: "c-abc" });
  });

  it("старые форматы после появления пар разбираются как раньше (Р116)", () => {
    expect(parseStartParam("c-AbCdEf123456")).toEqual({ kind: "click", raw: "c-AbCdEf123456", ref: "AbCdEf123456" });
    expect(parseStartParam("l-AbCdEf1234")).toEqual({ kind: "link", raw: "l-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("f-AbCdEf1234")).toEqual({ kind: "friend", raw: "f-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("n-friend_request")).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
    expect(parseStartParam("invite")).toEqual({ kind: "invite", raw: "invite", ref: null });
    expect(parseStartParam("_tgr_123")).toEqual({ kind: "telegram_affiliate", raw: "_tgr_123", ref: "123" });
    // Вход в панель и подтверждение роли разбирает бот раньше атрибуции; здесь они не пары.
    for (const value of ["panel-AbCdEfGhIjKlMnOpQrStUv", "role-AbCdEfGhIjKlMnOpQrStUv"]) expect(parseStartParam(value), value).toEqual({ kind: "unknown", raw: value, ref: null });
  });

  it("список видов запуска включает «tagged» — ссылку с метками", () => {
    expect(START_KINDS).toContain("tagged");
    expect(parseStartParam("src-tgads_cmp-oct")).toMatchObject({ kind: "tagged", ref: "src-tgads_cmp-oct" });
  });

  it("то, чего Telegram не пропускает, не хранится даже сырым", () => {
    expect(parseStartParam("c-<script>")).toEqual({ kind: "unknown", raw: null, ref: null });
    // У Mini App предел 512 знаков, у /start бота — 64 (T-0181): 65 знаков без канала — ещё Mini App.
    expect(parseStartParam("x".repeat(513))).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam("x".repeat(65), "bot")).toEqual({ kind: "unknown", raw: null, ref: null });
  });
});

// Прямая ссылка сети для рекламы (Р117, Р121, T-0181): код ссылки и метки клика едут
// в одном параметре запуска, а сервер разбирает хвост по ключам профиля сети.
describe("прямая ссылка сети: l-<код>_<метки> (T-0181)", () => {
  const CODE = "AbC123xyz9";
  const link = (tail: string) => `l-${CODE}${tail}`;

  it("ключи меток — те же, что у параметров переходника", () => {
    expect([...NETWORK_PARAM_KEYS]).toEqual(["campaign", "banner", "pub", "clickid", "record"]);
  });

  it("полный образец из кабинета: record берёт остаток строки вместе с _ и -", () => {
    const raw = link("_campaign-55_clickid-3f2a-9c_record-r_5-aB_9");
    expect(parseStartParam(raw)).toEqual({ kind: "link", raw, ref: CODE, networkParams: { campaign: "55", clickid: "3f2a-9c", record: "r_5-aB_9" } });
  });

  it("без clickid; порядок обычных ключей не важен", () => {
    expect(parseStartParam(link("_campaign-55_record-r1"))).toMatchObject({ kind: "link", ref: CODE, networkParams: { campaign: "55", record: "r1" } });
    expect(parseStartParam(link("_clickid-7_campaign-55_record-r1"))).toMatchObject({ networkParams: { clickid: "7", campaign: "55", record: "r1" } });
  });

  it("record стоит последним по соглашению: поставленный раньше забирает остаток вместе с чужими ключами", () => {
    expect(parseStartParam(link("_record-r1_campaign-55"))).toMatchObject({ networkParams: { record: "r1_campaign-55" } });
  });

  it("без хвоста — ровно прежний вид link, поля networkParams нет", () => {
    expect(parseStartParam(link(""))).toEqual({ kind: "link", raw: link(""), ref: CODE });
    expect(parseStartParam(link(""))).not.toHaveProperty("networkParams");
  });

  it("неподставленные макросы отбрасываются, остальное остаётся", () => {
    expect(parseStartParam(link("_campaign-_clickid-77_record-"))).toEqual({ kind: "link", raw: link("_campaign-_clickid-77_record-"), ref: CODE, networkParams: { clickid: "77" } });
    const empty = parseStartParam(link("_campaign-_record-"));
    expect(empty).toEqual({ kind: "link", raw: link("_campaign-_record-"), ref: CODE });
    expect(empty).not.toHaveProperty("networkParams");
  });

  it("буквальные макросы в фигурных скобках: скобок нет в алфавите Telegram, параметр не хранится даже сырым", () => {
    expect(parseStartParam(link("_campaign-{campaign_id}"))).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam(link("_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}"))).toEqual({ kind: "unknown", raw: null, ref: null });
  });

  it("хвост не разобрался — запуск всё равно ссылка с кодом, атрибуция не теряется", () => {
    for (const tail of ["_hello", "_", "_foo-1", "_src-x_cmp-y", "_hello_campaign-5", "__campaign-5", "_Campaign-5", "_campaign"]) {
      const parsed = parseStartParam(link(tail));
      expect(parsed, tail).toEqual({ kind: "link", raw: link(tail), ref: CODE });
      expect(parsed, tail).not.toHaveProperty("networkParams");
    }
  });

  it("повтор ключа — берётся первый", () => {
    expect(parseStartParam(link("_campaign-1_campaign-2"))).toMatchObject({ kind: "link", networkParams: { campaign: "1" } });
  });

  it("значение длиннее 256 знаков отбрасывается, остальные метки остаются", () => {
    const parsed = parseStartParam(link(`_campaign-5_clickid-${"c".repeat(257)}`));
    expect(parsed).toMatchObject({ kind: "link", networkParams: { campaign: "5" } });
    expect(parsed.networkParams).not.toHaveProperty("clickid");
    expect(parseStartParam(link(`_campaign-5_clickid-${"c".repeat(256)}`)).networkParams).toHaveProperty("clickid", "c".repeat(256));
  });

  it("плохой код ссылки: пары и метки не спасают, сырая строка остаётся", () => {
    // Три знака и семнадцать — вне правила LINK_CODE.
    for (const raw of ["l-abc_campaign-5", "l-Ab12Cd34Ef56Gh78X_campaign-5"]) expect(parseStartParam(raw), raw).toEqual({ kind: "unknown", raw, ref: null });
  });

  it("длина Mini App — 512: ровно 512 разбираются, 513 — не хранятся", () => {
    const head = link("_record-");
    const at512 = head + "a".repeat(512 - head.length);
    expect(at512).toHaveLength(512);
    // Запись длиннее 256 знаков — не метка: запуск остаётся ссылкой, без record.
    const parsed = parseStartParam(at512);
    expect(parsed).toEqual({ kind: "link", raw: at512, ref: CODE });
    expect(parseStartParam(at512, "miniapp")).toEqual(parsed);
    expect(parseStartParam(at512 + "a")).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam(at512 + "a", "miniapp")).toEqual({ kind: "unknown", raw: null, ref: null });
    // Запись на предельной длине поля — 256 знаков — остаётся меткой.
    const head256 = link("_campaign-5_record-");
    const full = head256 + "r".repeat(256);
    expect(parseStartParam(full).networkParams).toEqual({ campaign: "5", record: "r".repeat(256) });
  });

  it("длина бота — 64: ровно 64 разбираются, 65 — не хранятся; без канала 65 — ещё Mini App", () => {
    const head = link("_record-");
    const at64 = head + "b".repeat(64 - head.length);
    expect(at64).toHaveLength(64);
    expect(parseStartParam(at64, "bot")).toEqual({ kind: "link", raw: at64, ref: CODE, networkParams: { record: "b".repeat(64 - head.length) } });
    expect(parseStartParam(at64 + "b", "bot")).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam(at64 + "b")).toMatchObject({ kind: "link", ref: CODE });
    expect(parseStartParam(at64 + "b", "miniapp")).toMatchObject({ kind: "link", ref: CODE });
  });

  it("мусор вне алфавита не хранится ни в одном канале", () => {
    for (const channel of ["miniapp", "bot"] as const) {
      expect(parseStartParam("c-<script>", channel)).toEqual({ kind: "unknown", raw: null, ref: null });
      expect(parseStartParam(link("_campaign-а"), channel)).toEqual({ kind: "unknown", raw: null, ref: null });
    }
  });

  it("остальные виды разбираются в обоих каналах как раньше", () => {
    for (const channel of ["miniapp", "bot"] as const) {
      expect(parseStartParam("c-AbCdEf123456", channel)).toEqual({ kind: "click", raw: "c-AbCdEf123456", ref: "AbCdEf123456" });
      expect(parseStartParam("l-AbC123xyz9", channel)).toEqual({ kind: "link", raw: "l-AbC123xyz9", ref: CODE });
      expect(parseStartParam("f-AbCdEf1234", channel)).toEqual({ kind: "friend", raw: "f-AbCdEf1234", ref: "AbCdEf1234" });
      expect(parseStartParam("n-friend_request", channel)).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
      expect(parseStartParam("invite", channel)).toEqual({ kind: "invite", raw: "invite", ref: null });
      expect(parseStartParam("_tgr_123", channel)).toEqual({ kind: "telegram_affiliate", raw: "_tgr_123", ref: "123" });
      expect(parseStartParam("src-tgads_cmp-oct", channel)).toMatchObject({ kind: "tagged", ref: "src-tgads_cmp-oct" });
      expect(parseStartParam(null, channel)).toEqual({ kind: "organic", raw: null, ref: null });
    }
  });

  it("у видов, кроме link, поля networkParams нет", () => {
    for (const value of ["c-AbCdEf123456", "f-AbCdEf1234", "invite", "src-tgads_cmp-oct", "r-123_source-channel"]) expect(parseStartParam(value), value).not.toHaveProperty("networkParams");
  });
});
