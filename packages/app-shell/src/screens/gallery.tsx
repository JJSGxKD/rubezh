import { useState, type ReactNode } from "react";
import { Gem, Star, X } from "lucide-react";
import type { RunResult, UpgradeChange, UpgradeOption } from "@bh/shared-types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  ContentColumn,
  CurrencyChip,
  Emblem,
  IconButton,
  IconEmblem,
  ListGroup,
  ListItem,
  ProgressBar,
  Screen,
  SectionTitle,
  SegmentedControl,
  Stat,
  StubNotice,
  StubScreen,
  Wordmark,
} from "../design-system/components";
import { t } from "../i18n";
import { useNavigation } from "../state/navigation";
import { BootScreen } from "./gates";
import { RunLoading } from "./run/RunLoading";
import { DeathOverlay, LevelUpOverlay, PauseOverlay } from "./run/overlays";

/**
 * Витрина компонентов — экран внутри приложения, доступный в режиме
 * диагностики (docs/27-design-system-and-app-shell.md §9).
 *
 * Вместо Storybook, и для нашей задачи это лучше него: компоненты видны в
 * настоящем WebView Telegram на настоящем устройстве, с настоящими отступами
 * безопасной зоны, а не в десктопном браузере.
 *
 * Экраны забега и загрузки открываются здесь на тестовых данных: иначе чтобы
 * посмотреть экран смерти в ландшафте, пришлось бы умереть в ландшафте.
 */
type Preview = "boot" | "runLoading" | "levelUp" | "levelUpLong" | "pause" | "death" | "record";

export function GalleryScreen(): ReactNode {
  const navigation = useNavigation();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [segment, setSegment] = useState("daily");

  if (preview !== null) {
    return <PreviewFrame preview={preview} onClose={() => setPreview(null)} />;
  }

  return (
    <Screen title={t("gallery.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <SectionTitle>{t("gallery.screens")}</SectionTitle>
        <ListGroup>
          <ListItem title={t("gallery.preview.boot")} onClick={() => setPreview("boot")} />
          <ListItem title={t("gallery.preview.runLoading")} onClick={() => setPreview("runLoading")} />
          <ListItem title={t("gallery.preview.levelUp")} onClick={() => setPreview("levelUp")} />
          <ListItem
            title={t("gallery.preview.levelUpLong")}
            onClick={() => setPreview("levelUpLong")}
          />
          <ListItem title={t("gallery.preview.pause")} onClick={() => setPreview("pause")} />
          <ListItem title={t("gallery.preview.death")} onClick={() => setPreview("death")} />
          <ListItem title={t("gallery.preview.record")} onClick={() => setPreview("record")} />
        </ListGroup>

        <SectionTitle>{t("gallery.brand")}</SectionTitle>
        <div className="flex items-center justify-around gap-4 py-2">
          <Emblem size={72} animated />
          <Wordmark />
          <IconEmblem>
            <Star size={24} fill="currentColor" />
          </IconEmblem>
          <IconEmblem tone="info">
            <Gem size={24} />
          </IconEmblem>
        </div>

        <SectionTitle>{t("gallery.buttons")}</SectionTitle>
        <div className="grid gap-2">
          <Button glow>primary + glow</Button>
          <Button>primary</Button>
          <Button variant="secondary">secondary</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="danger">danger</Button>
          <Button loading>loading</Button>
          <Button disabled>disabled</Button>
          <Button size="l" block glow>
            large block
          </Button>
        </div>

        <SectionTitle>{t("gallery.cards")}</SectionTitle>
        <div className="grid gap-2">
          <Card>
            <span className="font-display text-base font-bold text-text">Обычная карточка</span>
            <p className="mt-1 text-xs text-text-muted">
              Самый длинный текст, который встретится: русские заголовки длиннее английских
              примерно в полтора раза, и проверять вёрстку надо на них.
            </p>
          </Card>
          <Card selected stripe="weapon" onClick={() => undefined}>
            Выбранная, с кромкой оружия
          </Card>
          <Card stripe="passive">С кромкой пассивки</Card>
          <Card disabled>Недоступная</Card>
        </div>

        <SectionTitle>{t("gallery.lists")}</SectionTitle>
        <ListGroup>
          <ListItem title="Со значением" value="42" />
          <ListItem title="С подписью" hint="Пояснение под заголовком" />
          <ListItem title="С переходом" onClick={() => undefined} />
          <ListItem title="С переключателем" toggle={{ checked: true, onChange: () => undefined }} />
          <ListItem
            title="Выключенный переключатель"
            hint="И подпись, объясняющая почему"
            toggle={{ checked: false, disabled: true, onChange: () => undefined }}
          />
        </ListGroup>

        <SectionTitle>{t("gallery.segmented")}</SectionTitle>
        <SegmentedControl
          label={t("gallery.segmented")}
          activeId={segment}
          onSelect={setSegment}
          items={[
            { id: "daily", label: t("tasks.daily") },
            { id: "weekly", label: t("tasks.weekly") },
            { id: "achievements", label: t("tasks.achievements") },
          ]}
        />

        <SectionTitle>{t("gallery.progress")}</SectionTitle>
        <div className="grid gap-3">
          <ProgressBar value={7} max={10} tone="hp" height="thick" label="HP" />
          <ProgressBar value={2} max={10} tone="hp-low" height="thick" label="HP" />
          <ProgressBar value={4} max={10} tone="xp" height="thin" label="XP" />
          <ProgressBar value={2} max={3} tone="accent" shimmer label={t("app.loading")} />
        </div>

        <SectionTitle>{t("gallery.stats")}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Время выживания" value="7:42" large tone="accent" />
          <Stat label="Убито" value="1 284" />
        </div>

        <SectionTitle>{t("gallery.badges")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>обычный</Badge>
          <Badge tone="accent">акцент</Badge>
          <Badge tone="warning">скоро</Badge>
          <Badge tone="info">инфо</Badge>
          <Badge tone="weapon">оружие</Badge>
          <Badge tone="passive">пассивка</Badge>
          <CurrencyChip icon={<Gem size={14} />} value="1 200" />
          <Avatar name="Иван Петров" />
        </div>

        <SectionTitle>{t("gallery.stub")}</SectionTitle>
        <StubScreen icon={<Star size={36} />} title="Заглушка раздела" text={t("shop.soon")} />
        <StubNotice text={t("reward.stub")} />
      </ContentColumn>
    </Screen>
  );
}

function PreviewFrame(props: { preview: Preview; onClose(): void }): ReactNode {
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {renderPreview(props.preview)}
      <div
        className="absolute top-[calc(0.5rem+var(--app-inset-top))] right-[calc(0.5rem+var(--app-inset-right))] rounded-full bg-bg/80"
        style={{ zIndex: "var(--z-toast)" }}
      >
        <IconButton label={t("app.close")} onClick={props.onClose}>
          <X size={22} />
        </IconButton>
      </div>
    </div>
  );
}

function renderPreview(preview: Preview): ReactNode {
  const noop = (): void => undefined;

  switch (preview) {
    case "boot":
      return <BootScreen stage="fonts" version="0.0.0-gallery" />;
    case "runLoading":
      return <RunLoading stage="world" weaponId="spark" />;
    case "levelUp":
      return (
        <LevelUpOverlay
          level={4}
          offers={SAMPLE_OFFERS}
          queued={0}
          loadout={{ weapons: [{ id: "spark", level: 2 }], passives: [{ id: "might", level: 1 }] }}
          onChoose={noop}
        />
      );
    case "levelUpLong":
      return (
        <LevelUpOverlay
          level={12}
          offers={LONG_OFFERS}
          queued={2}
          loadout={{
            weapons: [
              { id: "spark", level: 5 },
              { id: "knife", level: 3 },
              { id: "storm", level: 2 },
            ],
            passives: [
              { id: "might", level: 3 },
              { id: "haste", level: 2 },
              { id: "ward", level: 1 },
            ],
          }}
          onChoose={noop}
        />
      );
    case "pause":
      return <PauseOverlay elapsedSec={187} onResume={noop} onSettings={noop} onSurrender={noop} />;
    case "death":
      return (
        <DeathOverlay
          result={SAMPLE_RESULT}
          isNewRecord={false}
          diagnostics
          onRestart={noop}
          onMenu={noop}
          onShare={noop}
        />
      );
    default:
      return (
        <DeathOverlay
          result={SAMPLE_RESULT}
          isNewRecord
          diagnostics={false}
          onRestart={noop}
          onMenu={noop}
          onShare={noop}
        />
      );
  }
}

function change(
  labelKey: string,
  from: number | null,
  to: number,
  format: UpgradeChange["format"] = "value",
  lowerIsBetter = false,
): UpgradeChange {
  return { labelKey, from, to, format, lowerIsBetter };
}

const KNIFE_NEW: UpgradeOption = {
  id: "w:knife",
  kind: "weapon_new",
  refId: "knife",
  level: 1,
  nameKey: "weapon.knife.name",
  descriptionKey: "weapon.knife.description",
  changes: [
    change("upgrade.stat.damage", null, 5),
    change("upgrade.stat.cooldownSec", null, 0.5, "value", true),
    change("upgrade.stat.projectiles", null, 2),
    change("upgrade.stat.pierce", null, 1),
  ],
};

const SAMPLE_OFFERS: UpgradeOption[] = [
  KNIFE_NEW,
  {
    id: "w:spark",
    kind: "weapon_level",
    refId: "spark",
    level: 3,
    nameKey: "weapon.spark.name",
    descriptionKey: "weapon.spark.description",
    changes: [
      change("upgrade.stat.damage", 7, 8),
      change("upgrade.stat.cooldownSec", 0.26, 0.24, "value", true),
      change("upgrade.stat.projectiles", 1, 2),
      change("upgrade.stat.projectileSpeed", 520, 540),
    ],
  },
  {
    id: "p:might",
    kind: "passive_level",
    refId: "might",
    level: 2,
    nameKey: "passive.might.name",
    descriptionKey: "passive.might.description",
    changes: [change("upgrade.stat.passive.damage", 1.1, 1.2, "percent")],
  },
];

/** Самые длинные тексты словаря — на них вёрстка ломается первой (§4.3). */
const LONG_OFFERS: UpgradeOption[] = [
  {
    id: "p:mending",
    kind: "passive_new",
    refId: "mending",
    level: 1,
    nameKey: "passive.mending.name",
    descriptionKey: "passive.mending.description",
    changes: [change("upgrade.stat.passive.regenPerSec", null, 0.4, "plus")],
  },
  KNIFE_NEW,
  {
    id: "heal",
    kind: "heal",
    refId: "",
    level: 1,
    nameKey: "upgrade.heal.name",
    descriptionKey: "upgrade.heal.description",
    changes: [change("upgrade.stat.heal", null, 30)],
  },
];

const SAMPLE_RESULT: RunResult = {
  runId: "gallery-0000",
  seed: 424242,
  outcome: "died",
  startingWeaponId: "spark",
  mapId: "frontier",
  contentHash: "gallery",
  waveReached: 6,
  survivalSec: 463,
  level: 17,
  xpCollected: 2140,
  enemiesKilled: 1284,
  killsByEnemy: {},
  damageDealt: 48210,
  damageTaken: 930,
  weapons: [
    { id: "spark", level: 5, damage: 21840 },
    { id: "wardstone", level: 3, damage: 15320 },
    { id: "storm", level: 2, damage: 11050 },
  ],
  passives: [{ id: "might", level: 3 }],
  deathCause: "dasher_wolf",
  distance: 18400,
  peakEnemies: 212,
};
