import { useState, type ReactNode } from "react";
import type { LeaderboardEntry } from "@bh/shared-types";
import { Button, ContentColumn, Screen, SectionTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/gallery";
import type { EmblemItem, EmblemsView } from "../../state/emblems-api";
import { EmblemChip, type EmblemLook } from "./emblem-chip";
import { emblemFit } from "./emblem-rules";
import { EmblemWearSheet, EmblemsBody } from "./emblems";
import { LeaderboardRow } from "./rating";

/**
 * Витрина знаков у имени (tasks/T-0236): чипы всех редкостей, `team` и
 * `partner`, закрытый знак, раздел «Знаки» на тестовых данных, лист выбора и
 * строка рейтинга на 320 и 390 px. Лежит в чанке витрины компонентов — игроку не
 * нужна.
 */

const CHIPS: readonly EmblemLook[] = [
  { id: "emb_tester", title: "Обычный", tier: "common", category: "status" },
  { id: "ach_runs_200", title: "Необычный", tier: "uncommon", category: "merit" },
  { id: "ach_no_hit_10", title: "Редкий", tier: "rare", category: "merit" },
  { id: "ach_boss_25", title: "Эпический", tier: "epic", category: "merit" },
  { id: "emb_vip", title: "Легендарный", tier: "legendary", category: "status" },
  { id: "emb_season_champion", title: "Чемпион", tier: "mythic", category: "season", season: 3 },
  { id: "emb_team", title: "Команда", tier: "team", category: "status" },
  { id: "emb_partner", title: "Партнёр", tier: "partner", category: "status" },
];

const item = (look: EmblemLook, held: boolean, extra: Partial<EmblemItem> = {}): EmblemItem => ({
  ...look,
  hint: held ? null : "Условие получения знака",
  held,
  percent: held ? null : 4.2,
  ...extra,
});

const VIEW: EmblemsView = {
  shown: "emb_vip",
  auto: false,
  items: [
    item(CHIPS[0] as EmblemLook, false, { title: "Тестер" }),
    item(CHIPS[4] as EmblemLook, true, { title: "VIP", percent: 2.1 }),
    item({ id: "emb_supporter", title: "Меценат", tier: "epic", category: "status" }, false),
    item(CHIPS[5] as EmblemLook, false),
    item({ id: "emb_season_top10", title: "Топ-10", tier: "legendary", category: "season", season: 2 }, true),
    item(CHIPS[3] as EmblemLook, true, { percent: 6 }),
    item(CHIPS[2] as EmblemLook, false, { hint: "Пройди забег без единого попадания", percent: 1.5 }),
    item({ id: "ach_hidden_marathon", title: "Скрытый знак", tier: "epic", category: "merit" }, false, { hint: "Не всё на виду", percent: null }),
  ],
};

const ROW: LeaderboardEntry = {
  rank: 4,
  name: "Ярослава Д.",
  photoUrl: null,
  survivalSec: 1_788,
  level: 38,
  startingWeaponId: "spark",
  enemiesKilled: 2_250,
  isMe: false,
  points: 8_120,
  style: "h",
  division: "gold",
  emblem: { id: "ach_boss_25", title: "Гроза боссов", tier: "epic", category: "merit" },
};

export function EmblemsPreview(): ReactNode {
  const [sheet, setSheet] = useState(false);
  const [view, setView] = useState<EmblemsView>(VIEW);
  const choose = (id: string | null) => Promise.resolve({ ok: true as const, data: { shown: id ?? "emb_vip", auto: id === null } });
  return (
    <Screen title={t("gallery.preview.emblems")}>
      <ContentColumn>
        <SectionTitle>{t("gallery.emblems.chips")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {CHIPS.map((look) => (
            <EmblemChip key={look.id} emblem={look} size="l" fit="full" />
          ))}
          <EmblemChip emblem={{ id: "emb_vip", title: "VIP", tier: "legendary", category: "status" }} size="l" fit="glyph" />
          <EmblemChip emblem={{ id: "emb_tester", title: "Закрытый знак", tier: "rare", category: "status" }} size="l" fit="full" closed />
        </div>
        <SectionTitle>{t("gallery.emblems.rows")}</SectionTitle>
        <div className="grid gap-3">
          {[320, 390].map((width) => (
            <ol key={width} className="grid gap-2" style={{ maxWidth: width }}>
              <LeaderboardRow entry={ROW} index={0} scoring="points" emblemFit={emblemFit(width)} />
            </ol>
          ))}
        </div>
        <SectionTitle>{t("gallery.emblems.screen")}</SectionTitle>
        <EmblemsBody view={view} onPick={() => setSheet(true)} />
        <div className="mt-3">
          <Button track="emblem_sheet" variant="secondary" block onClick={() => setSheet(true)}>
            {t("emblems.wear")}
          </Button>
        </div>
      </ContentColumn>
      {sheet ? <EmblemWearSheet view={view} choose={choose} onChosen={(choice) => setView({ ...view, ...choice })} onStale={() => undefined} onClose={() => setSheet(false)} /> : null}
    </Screen>
  );
}
