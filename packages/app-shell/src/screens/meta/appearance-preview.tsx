import { useState, type ReactNode } from "react";
import { Button, ContentColumn, Screen, SectionTitle } from "../../design-system/components";
import { AvatarFace } from "../../design-system/components/Data";
import { t } from "../../i18n";
import "../../i18n/gallery";
import type { AppearanceItem, AppearanceView } from "../../state/appearance-api";
import { AppearanceBody, LockedSheet } from "./appearance";

/**
 * Витрина обликов (tasks/T-0238): раздел «Облик» на тестовых данных — все
 * редкости, закрытые с источниками, выбранный и «идёт запрос», — лист закрытого
 * облика и кружок аватара с головой, с фото и без арта. Лежит в чанке витрины
 * компонентов — игроку не нужна.
 */

const item = (id: string, rarity: string, held: boolean, source: AppearanceItem["source"]): AppearanceItem => ({ id, archetype: id, rarity, held, source });

const VIEW: AppearanceView = {
  selected: "vityaz",
  effective: "vityaz",
  avatarPhoto: false,
  items: [
    item("keeper", "common", true, { kind: "start" }),
    item("frost", "common", true, { kind: "level", level: 5 }),
    item("herbalist", "uncommon", true, { kind: "level", level: 10 }),
    item("gilded", "uncommon", true, { kind: "level", level: 15 }),
    item("vityaz", "rare", true, { kind: "level", level: 20 }),
    item("vedunya", "rare", false, { kind: "weekly_points" }),
    item("ohotnitsa", "epic", false, { kind: "achievement", achievementId: "ach_elite_50", title: "Гроза элит" }),
    item("skomoroh", "epic", false, { kind: "event" }),
    item("knyaz", "legendary", false, { kind: "vip" }),
    item("navi", "mythic", false, { kind: "season", maxPlace: 3 }),
  ],
};

const PHOTO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23556'/%3E%3C/svg%3E";

export function AppearancePreview(): ReactNode {
  const [view, setView] = useState<AppearanceView>(VIEW);
  const [sheet, setSheet] = useState<AppearanceItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <Screen title={t("gallery.preview.appearance")}>
      <ContentColumn>
        <SectionTitle>{t("gallery.appearance.avatars")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <AvatarFace name="Иван Петров" url={PHOTO} appearance="vityaz" viewerArt size={56} />
          <AvatarFace name="Иван Петров" url={PHOTO} appearance="navi" viewerArt size={36} />
          <AvatarFace name="Иван Петров" url={PHOTO} appearance="vityaz" avatarPhoto viewerArt size={56} />
          <AvatarFace name="Иван Петров" url={PHOTO} appearance="knyaz" viewerArt={false} size={56} />
          <AvatarFace name="Иван Петров" url={null} appearance="knyaz" viewerArt={false} size={56} />
        </div>
        <SectionTitle>{t("gallery.appearance.screen")}</SectionTitle>
        <AppearanceBody
          view={view}
          busy={busy}
          failed={failed}
          onWear={(next) => setView({ ...view, selected: next.id, effective: next.id })}
          onOpenLocked={setSheet}
          onAvatarPhoto={(checked) => setView({ ...view, avatarPhoto: checked })}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button track="appearance_busy" variant="secondary" block onClick={() => setBusy(busy === null ? "frost" : null)}>
            {t("gallery.appearance.busy")}
          </Button>
          <Button track="appearance_failed" variant="secondary" block onClick={() => setFailed(!failed)}>
            {t("gallery.appearance.failed")}
          </Button>
        </div>
      </ContentColumn>
      {sheet === null ? null : <LockedSheet item={sheet} onClose={() => setSheet(null)} />}
    </Screen>
  );
}
