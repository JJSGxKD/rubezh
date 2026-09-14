import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import type { RunCues } from "@bh/core-game";
import { audio } from "../audio";
import { isSoundId, readLabOverrides, recipeSchema, writeLabOverrides } from "../audio/lab-overrides";
import type { MusicState } from "../audio/music";
import { BUSES, SOUND_RECIPES, type BusId, type SoundId } from "../audio/recipes";
import type { SoundDirector } from "../audio/sound-director";
import {
  Badge,
  Button,
  ContentColumn,
  ListGroup,
  ListItem,
  Modal,
  ProgressBar,
  Screen,
  SectionTitle,
  SegmentedControl,
} from "../design-system/components";
import { Slider } from "../design-system/components/Slider";
import { t } from "../i18n";
import "../i18n/team";
import { HAPTIC_RULES, haptic, type HapticEvent } from "../state/haptics";
import { useNavigation } from "../state/navigation";
import { useShell } from "../state/shell";
import { VolumeSliders } from "./settings";

/**
 * Звуковая лаборатория (docs/31-audio-and-haptics.md §6): послушать каждый
 * звук, поправить рецепт на горячую, проверить грань на симуляции боя с
 * индикаторами шин, покрутить музыку и вибрацию. Правки живут на этом
 * устройстве; команде уходит копия рецепта.
 */
const TABS = ["sounds", "battle", "music", "feedback"] as const;
type Tab = (typeof TABS)[number];

const BUS_ORDER: readonly BusId[] = ["threats", "player", "rewards", "weapons", "enemies", "ui"];

export function SoundLabScreen(): ReactNode {
  const navigation = useNavigation();
  const [tab, setTab] = useState<Tab>("sounds");
  const [director, setDirector] = useState<SoundDirector | null>(null);

  useEffect(() => {
    let alive = true;
    void audio.director().then((loaded) => {
      if (alive) setDirector(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Screen title={t("soundLab.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <p className="mt-1 text-xs text-text-muted">{t("soundLab.intro")}</p>
        {director === null ? <p className="mt-3 text-sm text-text-muted">{t("soundLab.waiting")}</p> : <Meters director={director} />}
        <div className="mt-3">
          <SegmentedControl
            label={t("soundLab.title")}
            items={TABS.map((id) => ({ id, label: t(`soundLab.tab.${id}`) }))}
            activeId={tab}
            onSelect={(id) => setTab(id as Tab)}
          />
        </div>
        {director === null ? null : (
          <>
            {tab === "sounds" ? <SoundsTab director={director} /> : null}
            {tab === "battle" ? <BattleTab director={director} /> : null}
            {tab === "music" ? <MusicTab director={director} /> : null}
          </>
        )}
        {tab === "feedback" ? <FeedbackTab /> : null}
      </ContentColumn>
    </Screen>
  );
}

/** Индикаторы шин и общего выхода — десять раз в секунду: грань видна глазом. */
function Meters(props: { director: SoundDirector }): ReactNode {
  const [, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const { engine } = props.director;
  const master = engine.masterLevel();
  return (
    <div className="surface-sunken mt-3 grid gap-1.5 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
        <span>{t("soundLab.voices", { voices: engine.activeVoices() })}</span>
        <span>{t("soundLab.starts", { starts: engine.stats.starts, dropped: engine.stats.dropped })}</span>
      </div>
      <Meter label={t("soundLab.master")} value={master.peak} />
      {BUS_ORDER.map((bus) => (
        <Meter key={bus} label={t(`soundLab.bus.${bus}`)} value={engine.busLevel(bus).peak} />
      ))}
    </div>
  );
}

function Meter(props: { label: string; value: number }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-xs text-text-muted">{props.label}</span>
      <ProgressBar value={Math.min(1, props.value)} max={1} tone={props.value > 0.9 ? "hp-low" : "accent"} height="thin" label={props.label} />
    </div>
  );
}

function SoundsTab(props: { director: SoundDirector }): ReactNode {
  const [editing, setEditing] = useState<SoundId | null>(null);
  const [overrides, setOverrides] = useState(() => readLabOverrides(useShell.getState().storage));
  const ids = Object.keys(SOUND_RECIPES) as SoundId[];

  return (
    <>
      <SectionTitle>{t("settings.sound")}</SectionTitle>
      <VolumeSliders />
      {BUS_ORDER.map((bus) => (
        <section key={bus}>
          <SectionTitle>{t(`soundLab.bus.${bus}`)}</SectionTitle>
          <ListGroup>
            {ids
              .filter((id) => props.director.engine.recipes[id].bus === bus)
              .map((id) => (
                <ListItem
                  key={id}
                  title={id}
                  hint={overrides[id] === undefined ? t(`soundLab.sound.${id}`) : `${t(`soundLab.sound.${id}`)} · ${t("soundLab.edited")}`}
                  value={t("soundLab.edit")}
                  onClick={() => setEditing(id)}
                />
              ))}
          </ListGroup>
        </section>
      ))}
      <p className="mt-2 text-xs text-text-disabled">{t("soundLab.busHint", { weapons: BUSES.weapons.priority, enemies: BUSES.enemies.priority })}</p>
      {editing === null ? null : (
        <RecipeEditor
          director={props.director}
          id={editing}
          edited={overrides[editing] !== undefined}
          onSaved={() => setOverrides(readLabOverrides(useShell.getState().storage))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RecipeEditor(props: { director: SoundDirector; id: SoundId; edited: boolean; onSaved(): void; onClose(): void }): ReactNode {
  const { engine } = props.director;
  const [text, setText] = useState(() => JSON.stringify(engine.recipes[props.id], null, 2));
  const [message, setMessage] = useState<string | null>(null);

  const apply = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      setMessage(t("soundLab.error.json", { reason: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const recipe = recipeSchema.safeParse(parsed);
    if (!recipe.success) {
      const issue = recipe.error.issues[0];
      setMessage(t("soundLab.error.schema", { path: issue?.path.join(".") ?? "", reason: issue?.message ?? "" }));
      return;
    }
    engine.recipes[props.id] = recipe.data as (typeof engine.recipes)[SoundId];
    await engine.rerender(props.id);
    const storage = useShell.getState().storage;
    const overrides = readLabOverrides(storage);
    overrides[props.id] = engine.recipes[props.id];
    writeLabOverrides(storage, overrides);
    props.onSaved();
    setMessage(t("soundLab.applied"));
    engine.play(props.id, { force: true });
  };

  const reset = async (): Promise<void> => {
    const storage = useShell.getState().storage;
    const overrides = readLabOverrides(storage);
    delete overrides[props.id];
    writeLabOverrides(storage, overrides);
    if (isSoundId(props.id)) engine.recipes[props.id] = structuredClone(SOUND_RECIPES[props.id]);
    await engine.rerender(props.id);
    setText(JSON.stringify(engine.recipes[props.id], null, 2));
    props.onSaved();
    setMessage(t("soundLab.reset.done"));
  };

  const copy = async (): Promise<void> => {
    const code = `${props.id}: ${text},`;
    try {
      await navigator.clipboard.writeText(code);
      setMessage(t("soundLab.copied"));
    } catch (error: unknown) {
      // Буфер обмена в WebView часто закрыт: текст остаётся в поле, его выделяют руками.
      setMessage(t("soundLab.copyFailed", { reason: error instanceof Error ? error.name : "" }));
    }
  };

  return (
    <Modal
      title={props.id}
      placement="bottom"
      onDismiss={props.onClose}
      footer={
        <>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" block onClick={() => engine.play(props.id, { force: true })}>
              <Play size={16} />
              {t("soundLab.play")}
            </Button>
            <Button block onClick={() => void apply()}>
              {t("soundLab.apply")}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" block onClick={() => void copy()}>
              {t("soundLab.copy")}
            </Button>
            <Button variant="ghost" block disabled={!props.edited} onClick={() => void reset()}>
              <RotateCcw size={16} />
              {t("soundLab.reset")}
            </Button>
          </div>
        </>
      }
    >
      <p className="mb-2 text-xs text-text-muted">{t("soundLab.editorHint")}</p>
      <textarea
        aria-label={props.id}
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        className="surface-sunken h-72 w-full resize-y rounded-md p-3 font-mono text-xs text-text"
      />
      {message === null ? null : <p className="mt-2 text-xs text-text-muted">{message}</p>}
    </Modal>
  );
}

/**
 * Симуляция боя: сигналы забега без забега. Толпа, оружие и угрозы с
 * выставленной плотностью — слышно, где проходит грань и что она режет.
 */
function BattleTab(props: { director: SoundDirector }): ReactNode {
  const { director } = props;
  const [running, setRunning] = useState(false);
  const [weapons, setWeapons] = useState(3);
  const [crowd, setCrowd] = useState(50);
  const [rules, setRules] = useState(director.engine.rulesEnabled);
  const settings = useRef({ weapons, crowd });
  settings.current = { weapons, crowd };

  useEffect(() => {
    if (!running) return;
    director.setScene("run");
    const timer = setInterval(() => {
      const { weapons: count, crowd: density } = settings.current;
      director.setHud({ enemies: density * 1.2, hpRatio: 1, weapons: count });
      director.cues(simulatedCues(count, density / 100));
    }, 33);
    return () => {
      clearInterval(timer);
      director.setScene("lobby");
    };
  }, [running, director]);

  return (
    <>
      <SectionTitle>{t("soundLab.battle.weapons")}</SectionTitle>
      <SegmentedControl
        label={t("soundLab.battle.weapons")}
        items={[1, 2, 3, 4, 5].map((value) => ({ id: String(value), label: String(value) }))}
        activeId={String(weapons)}
        onSelect={(id) => setWeapons(Number(id))}
      />
      <div className="mt-3">
        <ListGroup>
          <Slider label={t("soundLab.battle.crowd")} value={crowd} onChange={setCrowd} />
          <ListItem
            title={t("soundLab.battle.rules")}
            hint={t("soundLab.battle.rules.hint")}
            toggle={{
              checked: rules,
              onChange: () => {
                director.engine.rulesEnabled = !rules;
                setRules(!rules);
              },
            }}
          />
        </ListGroup>
      </div>
      <div className="mt-3">
        <Button block glow={!running} variant={running ? "secondary" : "primary"} onClick={() => setRunning(!running)}>
          {running ? <Square size={16} fill="currentColor" /> : <Play size={16} />}
          {running ? t("soundLab.battle.stop") : t("soundLab.battle.start")}
        </Button>
      </div>
    </>
  );
}

const SIM_WEAPONS = ["spark", "knife", "wardstone", "hearth", "storm"] as const;

function simulatedCues(weapons: number, density: number): RunCues {
  const chance = (perSecond: number): number => (Math.random() < perSecond * 0.033 ? 1 : 0);
  const fired: Record<string, number> = {};
  SIM_WEAPONS.slice(0, weapons).forEach((id) => {
    fired[id] = chance(id === "hearth" ? 1.2 : id === "storm" ? 0.8 : 5);
  });
  return {
    playerHit: chance(0.6 * density),
    heal: chance(0.05),
    magnet: chance(0.03),
    dynamite: chance(0.02),
    explosions: chance(0.8 * density),
    explosionsNear: chance(0.2 * density),
    strikes: weapons >= 5 ? chance(0.8) : 0,
    kills: Math.round(Math.random() * 30 * density * 0.033 * 3),
    eliteKills: chance(0.03),
    eliteSpawns: chance(0.02),
    xp: chance(6 * density),
    fuses: chance(0.5 * density),
    dashWarns: chance(0.4 * density),
    dashes: chance(0.4 * density),
    enemyShots: chance(1.2 * density),
    weapons: fired,
  };
}

function MusicTab(props: { director: SoundDirector }): ReactNode {
  const { music } = props.director;
  const [state, setState] = useState<MusicState>({ running: music.running, context: music.currentContext, layers: 0, boost: false });
  const [intensity, setIntensity] = useState(40);
  const [lowHp, setLowHp] = useState(false);

  useEffect(() => music.onChange(setState), [music]);
  useEffect(() => music.setIntensity(intensity / 100), [music, intensity]);
  useEffect(() => music.setHealth(lowHp ? 0.12 : 1, "play"), [music, lowHp]);
  // Уход из вкладки возвращает музыку сцене оболочки.
  useEffect(() => () => props.director.setScene("lobby"), [props.director]);

  return (
    <>
      <SectionTitle>{t("soundLab.music.state")}</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={state.running ? "accent" : "muted"}>{state.running ? t(`soundLab.music.${state.context}`) : t("soundLab.music.off")}</Badge>
        <Badge tone="info">{t("soundLab.music.layers", { layers: state.layers })}</Badge>
        {state.boost ? <Badge tone="warning">{t("soundLab.music.boost")}</Badge> : null}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button variant="secondary" block onClick={() => music.start("lobby")}>
          {t("soundLab.music.lobby")}
        </Button>
        <Button variant="secondary" block onClick={() => music.start("run")}>
          {t("soundLab.music.run")}
        </Button>
        <Button variant="ghost" block onClick={() => music.stop()}>
          <Pause size={16} />
        </Button>
      </div>
      <div className="mt-3">
        <ListGroup>
          <Slider label={t("soundLab.music.intensity")} value={intensity} onChange={setIntensity} />
          <ListItem title={t("soundLab.music.lowHp")} toggle={{ checked: lowHp, onChange: () => setLowHp(!lowHp) }} />
        </ListGroup>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" block onClick={() => music.setScene("pause")}>
          {t("soundLab.music.pause")}
        </Button>
        <Button variant="secondary" block onClick={() => music.setScene("choice")}>
          {t("soundLab.music.choice")}
        </Button>
        <Button variant="secondary" block onClick={() => music.setScene("play")}>
          {t("soundLab.music.play")}
        </Button>
        <Button variant="secondary" block onClick={() => music.eliteBoost()}>
          {t("soundLab.music.boost")}
        </Button>
        <Button variant="danger" block onClick={() => props.director.runEvent("death")}>
          {t("soundLab.music.defeat")}
        </Button>
      </div>
    </>
  );
}

function FeedbackTab(): ReactNode {
  return (
    <>
      <SectionTitle>{t("soundLab.haptics")}</SectionTitle>
      <p className="mb-2 text-xs text-text-muted">{t("soundLab.haptics.hint")}</p>
      {/* Простые кнопки, а не Button: у Button свой отклик, и его щелчок
          съедал бы проверяемую вибрацию интервалом между ударами. */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(HAPTIC_RULES) as HapticEvent[]).map((event) => (
          <button
            key={event}
            type="button"
            onClick={() => haptic(event)}
            className="btn-secondary min-h-11 rounded-md px-3 font-display text-sm font-semibold"
          >
            {t(`soundLab.haptic.${event}`)}
          </button>
        ))}
      </div>
    </>
  );
}
