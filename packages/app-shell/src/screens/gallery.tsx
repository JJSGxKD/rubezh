import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Gem, Star, X } from "lucide-react";
import type { AdCreative, BlessingDef, LeaderboardEntry, ChestReward, RunResult, UpgradeChange, UpgradeOption } from "@bh/shared-types";
import { RunCardPreviewLazy as RunCardPreview } from "../app/lazy-screens";
import { AdCreativeCard, showCreative, type CreativeResult } from "../ads/ad-creative";
import {
  Avatar,
  Badge,
  Button,
  Card,
  ContentColumn,
  CurrencyChip,
  Emblem,
  IconButton,
  Hint,
  IconEmblem,
  ListGroup,
  ListItem,
  Modal,
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
import "../i18n/gallery";
import "../i18n/team";
import { useBackLayer } from "../state/back-stack";
import { useNavigation } from "../state/navigation";
import { homeFace } from "../state/prologue";
import type { ItemView } from "../state/items-api";
import { BootScreen } from "./gates";
import { EquipSlot, ItemTile, RARITIES, SLOTS } from "./meta/arsenal-parts";
import { LeaderboardRow, YouStrip } from "./meta/rating";
import { Podium } from "./meta/rating-podium";
import { DivisionPlaque, StyleCard } from "./meta/rating-style";
import { RunLoading } from "./run/RunLoading";
import { DeathOverlay } from "./run/DeathOverlay";
import { BlessingOverlay } from "./run/BlessingOverlay";
import { ChestOverlay } from "./run/ChestOverlay";
import { LevelUpOverlay, PauseOverlay } from "./run/overlays";
import { PrologueWinView } from "./run/PrologueWin";
import { SecondChance } from "./run/SecondChance";
import type { AdContinueStage } from "../state/ad-continue";
import type { GemContinueStage } from "../state/gem-continue";
import type { ContinueStage } from "../state/continue-purchase";

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
type Preview = "boot" | "runLoading" | "levelUp" | "levelUpLong" | "levelUpLimit" | "levelUpLimitHurt" | "pause" | "death" | "abandoned" | "rubezhHeld" | "levelUpRecommended" | "prologueWin" | "prologueWinPending" | "prologueWinOffline" | "homeBefore" | "homeAfter" | "chance" | "record" | "chest1" | "chest3" | "chest5" | "blessing" | "aside" | "rating" | "runCard";

export function GalleryScreen(): ReactNode {
  const navigation = useNavigation();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [segment, setSegment] = useState("daily");
  const [difficultySegment, setDifficultySegment] = useState("normal");
  const [sheet, setSheet] = useState<"long" | "pinned" | null>(null);
  const [adResult, setAdResult] = useState<CreativeResult["kind"] | null>(null);

  // Блок — тем же путём, что в игре: свой корень поверх приложения, «Назад» и Esc — через стек.
  const showAd = (viewSec: number, rewarded: boolean, ad: AdCreative = demoAd()): void => {
    setAdResult(null);
    void showCreative({ ad, viewSec, rewarded }, { onShown: () => undefined, onClick: () => undefined, openLink: () => undefined }).then((result) => setAdResult(result.kind));
  };

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
          <ListItem title={t("gallery.preview.levelUpLimit")} onClick={() => setPreview("levelUpLimit")} />
          <ListItem title={t("gallery.preview.levelUpLimitHurt")} onClick={() => setPreview("levelUpLimitHurt")} />
          <ListItem title={t("gallery.preview.pause")} onClick={() => setPreview("pause")} />
          <ListItem title={t("gallery.preview.death")} onClick={() => setPreview("death")} />
          <ListItem title={t("run.continue.title")} onClick={() => setPreview("chance")} />
          <ListItem title={t("gallery.preview.record")} onClick={() => setPreview("record")} />
          <ListItem title={t("gallery.preview.abandoned")} onClick={() => setPreview("abandoned")} />
          <ListItem title={t("gallery.preview.rubezhHeld")} onClick={() => setPreview("rubezhHeld")} />
          <ListItem title={t("gallery.preview.levelUpRecommended")} onClick={() => setPreview("levelUpRecommended")} />
          <ListItem title={t("gallery.preview.prologueWin")} onClick={() => setPreview("prologueWin")} />
          <ListItem title={t("gallery.preview.prologueWinPending")} onClick={() => setPreview("prologueWinPending")} />
          <ListItem title={t("gallery.preview.prologueWinOffline")} onClick={() => setPreview("prologueWinOffline")} />
          <ListItem title={t("gallery.preview.homeBefore")} onClick={() => setPreview("homeBefore")} />
          <ListItem title={t("gallery.preview.homeAfter")} onClick={() => setPreview("homeAfter")} />
          <ListItem title={t("gallery.preview.chest", { size: 1 })} onClick={() => setPreview("chest1")} />
          <ListItem title={t("gallery.preview.chest", { size: 3 })} onClick={() => setPreview("chest3")} />
          <ListItem title={t("gallery.preview.chest", { size: 5 })} onClick={() => setPreview("chest5")} />
          <ListItem title={t("gallery.preview.blessing")} onClick={() => setPreview("blessing")} />
          <ListItem title={t("gallery.preview.aside")} hint={t("gallery.preview.asideHint")} onClick={() => setPreview("aside")} />
          <ListItem title={t("gallery.preview.rating")} onClick={() => setPreview("rating")} />
          <ListItem title={t("gallery.preview.runCard")} onClick={() => setPreview("runCard")} />
        </ListGroup>

        <SectionTitle>{t("gallery.modals")}</SectionTitle>
        <ListGroup>
          <ListItem title={t("gallery.modal.long")} hint={t("gallery.modal.longHint")} onClick={() => setSheet("long")} />
          <ListItem title={t("gallery.modal.pinned")} hint={t("gallery.modal.pinnedHint")} onClick={() => setSheet("pinned")} />
        </ListGroup>

        <SectionTitle>{t("gallery.ads")}</SectionTitle>
        <ListGroup>
          <ListItem title={t("gallery.ad.rewarded")} hint={t("gallery.ad.rewardedHint")} onClick={() => showAd(10, true)} />
          <ListItem title={t("gallery.ad.interstitial")} hint={t("gallery.ad.interstitialHint")} onClick={() => showAd(5, false)} />
          <ListItem title={t("gallery.ad.noImage")} hint={t("gallery.ad.noImageHint")} onClick={() => showAd(10, true, { ...demoAd(), image: null })} />
        </ListGroup>
        {adResult === null ? null : <p className="px-1 pt-2 text-sm text-text-muted">{t("gallery.ad.result", { result: t(`gallery.ad.${adResult}`) })}</p>}
        <p className="px-1 pt-3 pb-2 text-xs text-text-muted">{t("gallery.ad.cardHint")}</p>
        <AdCreativeCard ad={demoAd()} onOpen={() => undefined} />

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
          <Button track="demo_primary_glow" glow>primary + glow</Button>
          <Button track="demo_primary">primary</Button>
          <Button track="demo_secondary" variant="secondary">secondary</Button>
          <Button track="demo_ghost" variant="ghost">ghost</Button>
          <Button track="demo_danger" variant="danger">danger</Button>
          <Button track="demo_loading" loading>loading</Button>
          <Button track="demo_disabled" disabled>disabled</Button>
          <Button track="demo_large" size="l" block glow>
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

        <SectionTitle>{t("gallery.widgets")}</SectionTitle>
        <WidgetsPreview />

        <SectionTitle>{t("gallery.rarity")}</SectionTitle>
        <RarityPreview />

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

        <SectionTitle>{t("gallery.hint")}</SectionTitle>
        <div className="grid gap-3">
          <Hint label={t("gallery.hint.label")} text={t("gallery.hint.text")}>
            <span className="text-sm text-text">{t("gallery.hint.label")}</span>
          </Hint>
          <Hint
            label={t("gallery.hint.label")}
            text={t("gallery.hint.text")}
            end={<span className="text-sm font-semibold tabular-nums text-success">+7%</span>}
            initiallyOpen
          >
            <span className="text-sm text-text">{t("gallery.hint.label")}</span>
          </Hint>
        </div>

        <SectionTitle>{t("gallery.segmented")}</SectionTitle>
        <SegmentedControl track="segment"
          label={t("gallery.segmented")}
          activeId={segment}
          onSelect={setSegment}
          items={[
            { id: "daily", label: t("tasks.daily") },
            { id: "weekly", label: t("tasks.weekly") },
            { id: "achievements", label: t("tasks.achievements") },
          ]}
        />
        <p className="mt-3 mb-1 text-xs text-text-muted">{t("gallery.segmented.smallHint")}</p>
        <SegmentedControl track="difficulty"
          size="s"
          label={t("gallery.segmented.small")}
          activeId={difficultySegment}
          onSelect={setDifficultySegment}
          items={["easy", "normal", "hard"].map((id) => ({ id, label: t(`difficulty.${id}.name`) }))}
        />

        <SectionTitle>{t("gallery.progress")}</SectionTitle>
        <div className="grid gap-3">
          <ProgressBar value={7} max={10} tone="hp" height="thick" label="HP" />
          <ProgressBar value={2} max={10} tone="hp-low" height="thick" label="HP" />
          <ProgressBar value={4} max={10} tone="xp" height="thin" label="XP" />
          <ProgressBar value={2} max={3} tone="accent" shimmer label={t("app.loading")} />
        </div>

        {/* Покупка второго шанса во всех состояниях: без Telegram и сервера их
            иначе не увидеть — окно оплаты есть только в клиенте. */}
        <SectionTitle>{t("run.continue.title")}</SectionTitle>
        <div className="grid gap-3">
          <SecondChance />
          {CONTINUE_STAGES.map((stage, index) => (
            <SecondChance key={index} paidPreview={stage} adPreview={AD_READY} />
          ))}
          {AD_STAGES.map(([ad, paid], index) => (
            <SecondChance key={`ad-${String(index)}`} adPreview={ad} {...(paid === null ? {} : { paidPreview: paid })} />
          ))}
          {/* Самоцветы (Р162): с роликом он главный, без ролика главные самоцветы;
              нехватка — выключенная кнопка с подписью. */}
          {GEM_STAGES.map(([gems, ad, paid], index) => (
            <SecondChance key={`gems-${String(index)}`} gemsPreview={gems} {...(ad === null ? {} : { adPreview: ad })} {...(paid === null ? {} : { paidPreview: paid })} />
          ))}
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
          <Badge tone="danger">−30%</Badge>
          <Badge tone="info">инфо</Badge>
          <Badge tone="weapon">оружие</Badge>
          <Badge tone="passive">пассивка</Badge>
          <CurrencyChip icon={<Gem size={14} />} value="1 200" />
          <Avatar name="Иван Петров" />
        </div>

        <SectionTitle>{t("gallery.stub")}</SectionTitle>
        <StubScreen icon={<Star size={36} />} title="Заглушка раздела" text={t("stub.soon")} />
        <StubNotice text={t("reward.stub")} />
      </ContentColumn>
      {sheet !== null ? <ModalsPreview pinFooter={sheet === "pinned"} onClose={() => setSheet(null)} /> : null}
    </Screen>
  );
}

/**
 * Объявление для витрины: картинка и значок — встроенными SVG, а не с чужого
 * адреса: витрина работает и без сети, и без рекламы в политике источников.
 */
function demoAd(): AdCreative {
  const svg = (body: string, size: number): string =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}">${body}</svg>`)}`;
  return {
    id: "gallery-demo",
    title: t("gallery.ad.demoTitle"),
    description: null,
    text: t("gallery.ad.demoText"),
    image: svg(
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#0b1020"/></linearGradient></defs>' +
        '<rect width="400" height="400" fill="url(#g)"/><circle cx="300" cy="90" r="38" fill="#f6c453"/>' +
        '<path d="M0 300 L80 220 L140 260 L220 170 L300 250 L400 190 L400 400 L0 400 Z" fill="#24365e"/>' +
        '<path d="M150 400 V250 h30 v-20 h20 v20 h20 v-20 h20 v20 h20 v-20 h20 v20 h30 V400 Z" fill="#3a5a99"/>',
      400,
    ),
    icon: svg('<rect width="96" height="96" rx="20" fill="#f6c453"/><path d="M28 70 V40 h10 v-8 h8 v8 h4 v-8 h8 v8 h10 v30 Z" fill="#1b2a4a"/>', 96),
    button: t("gallery.ad.demoButton"),
    link: "https://example.com",
    advertiser: t("gallery.ad.demoAdvertiser"),
  };
}

/**
 * Модалка в модалке (WP45): длинный лист, у которого крестик закреплён
 * сверху, и вторая модалка поверх него. «Назад» и Esc закрывают верхнюю,
 * лист под ней остаётся.
 */
function ModalsPreview(props: { pinFooter: boolean; onClose(): void }): ReactNode {
  const [nested, setNested] = useState(false);
  return (
    <>
      <Modal
        title={t(props.pinFooter ? "gallery.modal.pinned" : "gallery.modal.long")}
        placement="bottom"
        onDismiss={props.onClose}
        pinFooter={props.pinFooter}
        footer={
          <Button track="nested" block onClick={() => setNested(true)}>
            {t("gallery.modal.nested")}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-text-muted">{t("gallery.modal.longHint")}</p>
        <ul className="grid gap-2 text-sm text-text">
          {Array.from({ length: 30 }, (_, index) => (
            <li key={index} className="surface-card rounded-md px-3 py-2">
              {t("gallery.modal.line", { n: index + 1 })}
            </li>
          ))}
        </ul>
      </Modal>
      {nested ? (
        <Modal title={t("gallery.modal.nestedTitle")} onDismiss={() => setNested(false)}>
          <p className="text-sm text-text-muted">{t("gallery.modal.nestedHint")}</p>
        </Modal>
      ) : null}
    </>
  );
}

function PreviewFrame(props: { preview: Preview; onClose(): void }): ReactNode {
  // Превью закрывается «Назад» площадки и Esc, а не уводит с витрины.
  useBackLayer(props.onClose);
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {renderPreview(props.preview)}
      <div
        className="absolute top-[calc(0.5rem+var(--app-inset-top))] right-[calc(0.5rem+var(--app-inset-right))] rounded-full bg-bg/80"
        style={{ zIndex: "var(--z-toast)" }}
      >
        <IconButton track="close" label={t("app.close")} onClick={props.onClose}>
          <X size={22} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Плитки всех редкостей (design/art/direction-v2.md §4.4): у тестового
 * аккаунта снаряжения обычно нет, и без витрины рамки не посмотреть вживую.
 */
function RarityPreview(): ReactNode {
  const stat = { stat: "damage", value: 0.1 };
  const items: ItemView[] = RARITIES.map((rarity, index) => ({
    itemId: `gallery-${rarity}`,
    slot: SLOTS[index % SLOTS.length] ?? "weapon",
    rarity,
    level: 3 + index,
    equipped: false,
    power: 100,
    main: stat,
    extras: [],
    upgrade: null,
    reroll: null,
    salvage: 1,
  }));
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-5 pt-2">
        {items.map((item) => (
          <EquipSlot key={item.itemId} slot={item.slot} item={item} onOpen={() => undefined} />
        ))}
      </div>
      <div className="grid grid-cols-6 gap-2">
        {items.map((item) => (
          <ItemTile key={item.itemId} item={item} selected={false} dimmed={false} onPress={() => undefined} />
        ))}
      </div>
    </div>
  );
}

/**
 * Экран со второй колонкой (T-0298): на wide (с 1024 px) `aside` стоит справа,
 * уже — под основным содержимым. Без `aside` экран — обычная одна колонка, как
 * сама витрина.
 */
function AsidePreview(): ReactNode {
  return (
    <Screen
      title={t("gallery.preview.aside")}
      aside={
        <Card>
          <h3 className="font-display text-base font-bold text-text">{t("gallery.aside.side")}</h3>
          <p className="mt-1 text-sm text-text-muted">{t("gallery.aside.sideText")}</p>
        </Card>
      }
    >
      <SectionTitle>{t("gallery.aside.main")}</SectionTitle>
      <div className="grid gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Card key={index}>
            <span className="text-sm text-text">{t("gallery.modal.line", { n: index + 1 })}</span>
          </Card>
        ))}
      </div>
    </Screen>
  );
}

/** Игроки рейтинга на тестовых данных (T-0296): пьедестал, строки, «Ты» и «Твой стиль» во всех состояниях. */
const RATING_SAMPLE: LeaderboardEntry[] = [
  ["Велимир", 9_812, "t", "ruby"],
  ["Ярослава", 9_440, "k", "ruby"],
  ["Мирон", 8_905, "h", "gold"],
  ["Злата", 8_120, "h", "gold"],
  ["Тимур", 7_760, "b", "gold"],
].map(([name, points, style, division], index) => ({
  rank: index + 1,
  name: String(name),
  photoUrl: null,
  survivalSec: 1_908 - index * 120,
  level: 41 - index,
  startingWeaponId: "spark",
  enemiesKilled: 2_400 - index * 150,
  isMe: false,
  points: Number(points),
  style: String(style),
  division: String(division),
}));

function RatingPreview(): ReactNode {
  const me = { rank: 38, survivalSec: 612, points: 4_205, style: "c", division: "silver" };
  const above = RATING_SAMPLE.slice(4, 5).map((entry) => ({ ...entry, rank: 37, points: 4_345 }));
  return (
    <Screen title={t("gallery.preview.rating")}>
      <ContentColumn>
        <SectionTitle>{t("gallery.rating.podium")}</SectionTitle>
        <div className="grid gap-2">
          <Podium entries={RATING_SAMPLE} scoring="points" />
          <ol className="grid gap-2">
            {RATING_SAMPLE.slice(3).map((entry, index) => (
              <LeaderboardRow key={entry.rank} entry={entry} index={index} scoring="points" />
            ))}
          </ol>
        </div>
        <SectionTitle>{t("gallery.rating.podiumTwo")}</SectionTitle>
        <Podium entries={RATING_SAMPLE.slice(0, 2)} scoring="points" />
        <SectionTitle>{t("gallery.rating.you")}</SectionTitle>
        <div className="grid gap-2">
          <YouStrip me={me} entries={above} scoring="points" total={900} />
          <YouStrip me={{ ...me, rank: 1, points: 9_999, division: "ruby" }} entries={[]} scoring="points" total={900} />
          <YouStrip me={null} entries={[]} scoring="points" total={0} />
        </div>
        <SectionTitle>{t("gallery.rating.plaque")}</SectionTitle>
        <DivisionPlaque division="silver" best={{ kind: "points", value: 4_205 }} next={{ next: "gold", gap: 610, unit: "points" }} />
        <SectionTitle>{t("gallery.rating.style")}</SectionTitle>
        <div className="grid gap-2">
          <StyleCard summary={{ style: "c", strong: "c", weak: "k", axes: { t: 1.2, k: 0.6, h: 0.9, c: 1.5, b: 1 }, runs: 10, missing: 0 }} />
          <StyleCard summary={{ style: null, strong: null, weak: null, axes: null, runs: 1, missing: 2 }} />
        </div>
      </ContentColumn>
    </Screen>
  );
}

function renderPreview(preview: Preview): ReactNode {
  const noop = (): void => undefined;
  const shareNoop = (): Promise<null> => Promise.resolve(null);

  switch (preview) {
    case "aside":
      return <AsidePreview />;
    case "rating":
      return <RatingPreview />;
    case "runCard":
      return (
        <Suspense fallback={null}>
          <RunCardPreview />
        </Suspense>
      );
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
          onStats={noop}
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
          onStats={noop}
        />
      );
    case "levelUpLimit":
    case "levelUpLimitHurt":
      return (
        <LevelUpOverlay
          level={31}
          offers={preview === "levelUpLimit" ? LIMIT_OFFERS : LIMIT_OFFERS_HURT}
          queued={1}
          loadout={{
            weapons: [
              { id: "spark", level: 8 },
              { id: "knife", level: 8 },
            ],
            passives: [{ id: "might", level: 6 }],
          }}
          onChoose={noop}
          onStats={noop}
        />
      );
    case "chest1":
    case "chest3":
    case "chest5": {
      const size = preview === "chest1" ? 1 : preview === "chest3" ? 3 : 5;
      return <ChestOverlay chest={{ index: size, size, rewards: SAMPLE_CHEST.slice(0, size) }} onTake={noop} />;
    }
    case "blessing":
      return <BlessingOverlay options={SAMPLE_BLESSINGS} onChoose={noop} />;
    case "pause":
      return <PauseOverlay elapsedSec={187} onResume={noop} onSettings={noop} onSurrender={noop} onStats={noop} />;
    case "death":
      return (
        <DeathOverlay
          result={SAMPLE_RESULT}
          isNewRecord={false}
          diagnostics
          reward={{ status: "pending" }}
          onDecline={noop}
          onRestart={noop}
          onMenu={noop}
          onShare={shareNoop}
        />
      );
    case "abandoned":
      return (
        <DeathOverlay
          result={{ ...SAMPLE_RESULT, outcome: "abandoned" }}
          isNewRecord={false}
          diagnostics={false}
          reward={{ status: "pending" }}
          onDecline={noop}
          onRestart={noop}
          onMenu={noop}
          onShare={shareNoop}
        />
      );
    case "levelUpRecommended":
      // Первый выбор пролога: «Советуем» — у нового оружия, остальные карточки как обычно.
      return (
        <LevelUpOverlay
          level={2}
          offers={SAMPLE_OFFERS.map((offer, index) => (index === 0 ? { ...offer, recommended: true } : offer))}
          queued={0}
          loadout={{ weapons: [{ id: "spark", level: 1 }], passives: [] }}
          onChoose={noop}
          onStats={noop}
        />
      );
    case "prologueWin":
      return <PrologueWinView result={PROLOGUE_RESULT} reward={{ status: "granted", coins: 500, gems: 10 }} onHome={noop} />;
    case "prologueWinPending":
      return <PrologueWinView result={PROLOGUE_RESULT} reward={{ status: "pending" }} onHome={noop} />;
    case "prologueWinOffline":
      return <PrologueWinView result={PROLOGUE_RESULT} reward={{ status: "offline" }} onHome={noop} />;
    case "homeBefore":
      return <HomePreview open={false} />;
    case "homeAfter":
      return <HomePreview open />;
    case "rubezhHeld":
      return (
        <DeathOverlay
          result={{ ...SAMPLE_RESULT, rubezh: { reached: true, clearedSec: 702, guardHpPercent: null } }}
          isNewRecord={false}
          diagnostics={false}
          reward={{ status: "pending" }}
          onDecline={noop}
          onRestart={noop}
          onMenu={noop}
          onShare={shareNoop}
        />
      );
    case "chance":
      // Шаг 1: второй шанс — с теми же образцами стадий, что у блоков в витрине выше;
      // способ нужен, чтобы окно не перешло сразу к итогам, — здесь это кнопка разработчика.
      return (
        <DeathOverlay
          result={SAMPLE_RESULT}
          isNewRecord={false}
          diagnostics={false}
          secondChance={{ onDevContinue: noop, paidPreview: { kind: "ready", offer: LIVE_OFFER }, adPreview: AD_READY }}
          onDecline={noop}
          onRestart={noop}
          onMenu={noop}
          onShare={shareNoop}
        />
      );
    default:
      return (
        <DeathOverlay
          result={SAMPLE_RESULT}
          isNewRecord
          diagnostics={false}
          reward={{
            status: "granted",
            coins: 88,
            coinsCapped: false,
            xp: 165,
            levelBefore: 4,
            levelAfter: 5,
            progress: { level: 5, xp: 1400, xpIntoLevel: 21, xpForNext: 545, nextReward: { coins: 300, gems: 0 } },
          }}
          onDecline={noop}
          onRestart={noop}
          onMenu={noop}
          onShare={shareNoop}
        />
      );
  }
}

const LIVE_OFFER = { continueNo: 1, priceStars: 7, chargedStars: 7, mode: "live" } as const;

/** Состояния покупки для витрины — по одному на каждую строку, которую видит игрок. */
const CONTINUE_STAGES: readonly ContinueStage[] = [
  { kind: "ready", offer: LIVE_OFFER },
  { kind: "ready", offer: { ...LIVE_OFFER, chargedStars: 1, mode: "test" } },
  { kind: "confirming", offer: LIVE_OFFER, purchaseId: "preview" },
  { kind: "retry", reason: "slow_confirmation", offer: LIVE_OFFER, purchaseId: "preview" },
  { kind: "retry", reason: "offline", offer: null, purchaseId: null },
  { kind: "unavailable", reason: "unverified" },
];

const AD_READY: AdContinueStage = { kind: "ready", pass: false, notice: null };

/**
 * Второй шанс за рекламу рядом со звёздами и без них: VIP — одна кнопка,
 * исходы ролика — строкой, лимит на сегодня — только звёзды.
 */
const AD_STAGES: readonly (readonly [AdContinueStage, ContinueStage | null])[] = [
  [{ kind: "ready", pass: true, notice: null }, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "watching", pass: false }, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", pass: false, notice: "closed" }, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", pass: false, notice: "claim_failed" }, null],
  [{ kind: "unavailable", reason: "daily_cap" }, { kind: "ready", offer: LIVE_OFFER }],
];

const GEM_OFFER = { continueNo: 1, priceGems: 5, balance: 12 } as const;

/**
 * Второй шанс за самоцветы: цена и баланс, нехватка, загрузка, обрыв сети,
 * отпавший способ — рядом с роликом и звёздами и без них.
 */
const GEM_STAGES: readonly (readonly [GemContinueStage, AdContinueStage | null, ContinueStage | null])[] = [
  [{ kind: "ready", offer: GEM_OFFER, notice: null }, AD_READY, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", offer: GEM_OFFER, notice: null }, { kind: "unavailable", reason: "daily_cap" }, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", offer: { ...GEM_OFFER, balance: 3 }, notice: null }, { kind: "unavailable", reason: "daily_cap" }, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", offer: { ...GEM_OFFER, balance: 3 }, notice: null }, AD_READY, { kind: "ready", offer: LIVE_OFFER }],
  [{ kind: "ready", offer: GEM_OFFER, notice: "offline" }, { kind: "unavailable", reason: "daily_cap" }, null],
  [{ kind: "loading" }, { kind: "unavailable", reason: "daily_cap" }, null],
  [{ kind: "buying", offer: GEM_OFFER }, AD_READY, null],
  [{ kind: "unavailable", reason: "insufficient_funds" }, AD_READY, { kind: "ready", offer: LIVE_OFFER }],
];

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

/** Сундук: все виды наград — новое, уровни, лечение и опыт. */
/** Предложение капища для витрины: три из набора контента, как их отдаёт движок. */
const SAMPLE_BLESSINGS: BlessingDef[] = [
  { id: "fury", nameKey: "blessing.fury", modifiers: { damage: 0.1 } },
  { id: "wind", nameKey: "blessing.wind", modifiers: { moveSpeed: 0.08 } },
  { id: "fortress", nameKey: "blessing.fortress", modifiers: { maxHp: 10 } },
];

const SAMPLE_CHEST: ChestReward[] = [
  { ...SAMPLE_OFFERS[1]!, kind: "weapon_level" },
  { ...KNIFE_NEW, kind: "weapon_new" },
  { ...SAMPLE_OFFERS[2]!, kind: "passive_level" },
  { id: "heal", kind: "heal", refId: "", level: 0, nameKey: "upgrade.heal.name", descriptionKey: "upgrade.heal.description", changes: [] },
  { id: "xp", kind: "xp", refId: "", level: 0, nameKey: "upgrade.xp.name", descriptionKey: "upgrade.xp.description", changes: [change("upgrade.xp.label", null, 40, "plus")] },
];

/** «Предел» (T-0194): накопленное «было → стало» и самое длинное название. */
const LIMIT_OFFERS: UpgradeOption[] = [
  {
    id: "limit:damage",
    kind: "limit",
    refId: "damage",
    level: 3,
    nameKey: "upgrade.limit.damage.name",
    descriptionKey: "upgrade.limit.damage.description",
    changes: [change("upgrade.stat.passive.damage", 1.06, 1.09, "percent")],
  },
  {
    id: "limit:cooldown",
    kind: "limit",
    refId: "cooldown",
    level: 12,
    nameKey: "upgrade.limit.cooldown.name",
    descriptionKey: "upgrade.limit.cooldown.description",
    changes: [change("upgrade.stat.passive.cooldown", 0.78, 0.76, "percent", true)],
  },
  {
    id: "limit:regen",
    kind: "limit",
    refId: "regen",
    level: 1,
    nameKey: "upgrade.limit.regen.name",
    descriptionKey: "upgrade.limit.regen.description",
    changes: [change("upgrade.stat.passive.regenPerSec", 0, 0.1, "plus")],
  },
];

/** Здоровье ниже половины: две прибавки и лечение последним. */
const LIMIT_OFFERS_HURT: UpgradeOption[] = [
  LIMIT_OFFERS[0]!,
  LIMIT_OFFERS[1]!,
  {
    id: "heal",
    kind: "heal",
    refId: "",
    level: 0,
    nameKey: "upgrade.heal.name",
    descriptionKey: "upgrade.heal.description",
    changes: [change("upgrade.stat.heal", null, 30)],
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
  // Оружие со стихией: метка стихии рядом с уровнем — самая длинная строка тегов.
  {
    id: "w:sting",
    kind: "weapon_level",
    refId: "sting",
    level: 4,
    nameKey: "weapon.sting.name",
    descriptionKey: "weapon.sting.description",
    changes: [change("upgrade.stat.damage", 8, 9), change("upgrade.stat.pierce", 3, 4)],
  },
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

/**
 * Главная до и после победы в прологе: то же правило (`homeFace`), что у настоящей
 * главной, но без сторов — кнопка, строка под ней и метки «Новое» у виджетов.
 */
function HomePreview(props: { open: boolean }): ReactNode {
  const face = homeFace({ open: props.open, fresh: { daily: true, tasks: true, play: true } });
  return (
    <div className="mx-auto grid h-full max-w-[420px] content-end gap-3 p-4">
      {face.sections ? <HomeSectionsPreview marks={face.marks} /> : null}
      <div className="grid gap-1">
        <Button track="play" size="l" block glow cut shine>
          {t("lobby.play")}
        </Button>
        {face.line === null ? null : <p className="text-center text-xs text-text-muted">{t(face.line === "first" ? "lobby.prologue.first" : "lobby.prologue.next")}</p>}
      </div>
    </div>
  );
}

function HomeSectionsPreview(props: { marks: Record<"daily" | "tasks", boolean> }): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(["daily", "tasks"] as const).map((id, index) => (
        <div key={id} className="surface-sunken relative flex h-(--widget-tile-h) items-center justify-center rounded-lg font-display text-sm text-text">
          {t(id === "daily" ? "lobby.daily" : "tab.tasks")}
          {props.marks[id] ? (
            <span className="absolute top-1.5 right-1.5 rounded-pill bg-accent px-2 py-0.5 font-display text-[10px] font-bold tracking-wide text-on-accent uppercase" style={{ zIndex: index + 1 }}>
              {t("lobby.new")}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const SAMPLE_RESULT: RunResult = {
  runId: "gallery-0000",
  seed: 424242,
  outcome: "died",
  startingWeaponId: "spark",
  mapId: "frontier",
  difficultyId: "normal",
  contentHash: "gallery",
  waveReached: 6,
  survivalSec: 463,
  level: 17,
  xpCollected: 2140,
  enemiesKilled: 1284,
  killsByEnemy: {},
  damageDealt: 48210,
  damageTaken: 930,
  damageByElement: { physical: 9400, fire: 2100, cold: 800, lightning: 1600 },
  noHitSec: 0,
  noKillSec: 0,
  killsByElement: {},
  bossKills: 1,
  eliteKills: 6,
  chestsOpened: 3,
  crystalsCollected: 640,
  weapons: [
    { id: "spark", level: 5, damage: 21840 },
    { id: "wardstone", level: 3, damage: 15320 },
    { id: "storm", level: 2, damage: 11050 },
  ],
  passives: [{ id: "might", level: 3 }],
  deathCause: "dasher_wolf",
  distance: 18400,
  peakEnemies: 212,
  cheats: false,
  continues: [],
};

/** Победа в прологе на 3:04 — как приходит от движка: закрытый забег с итогом пролога. */
const PROLOGUE_RESULT: RunResult = { ...SAMPLE_RESULT, outcome: "abandoned", difficultyId: "easy", survivalSec: 184, mode: "prologue", prologue: { won: true, sec: 184 } };

/**
 * Все состояния виджетов главной (docs/35-stage4-plan.md WP42) — через чанк
 * главной (`home-live.ts`): прямой импорт унёс бы код виджетов в общий с
 * витриной чанк, и главная грузила бы на один файл больше.
 */
function WidgetsPreview(): ReactNode {
  const [Showcase, setShowcase] = useState<typeof import("./home-showcase").WidgetShowcase | null>(null);
  useEffect(() => {
    let alive = true;
    import("./home-live")
      .then(async (live) => await live.loadWidgetShowcase())
      .then(
        (module) => {
          if (alive) setShowcase(() => module.WidgetShowcase);
        },
        (error: unknown) => console.warn("Чанк главной не загрузился:", error),
      );
    return () => {
      alive = false;
    };
  }, []);
  return Showcase === null ? <p className="text-xs text-text-muted">{t("app.loading")}</p> : <Showcase now={Date.now()} />;
}
