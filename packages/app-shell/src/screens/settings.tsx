import { useState, type ReactNode } from "react";
import { CONTENT_HASH } from "@bh/core-game";
import {
  ContentColumn,
  Emblem,
  ListGroup,
  ListItem,
  Screen,
  SectionTitle,
  Wordmark,
} from "../design-system/components";
import { audio } from "../audio";
import { Slider } from "../design-system/components/Slider";
import { t } from "../i18n";
import "../i18n/bot";
import { noteAccountSetting } from "../state/account-settings";
import { BOT_NOTIFY_ACCOUNT_KEYS, BOT_NOTIFY_KEYS, useBotNotifications } from "../state/bot-notifications";
import { useDiagnostics } from "../state/diagnostics";
import { useGraphics } from "../state/graphics";
import { useHints } from "../state/hints";
import { useInstall } from "../state/install";
import { useNavigation } from "../state/navigation";
import { useToolsAccess } from "../state/tools";
import { useSettings, type VolumeKey } from "../state/settings";
import { useShell } from "../state/shell";
import { TestNoticeText } from "./meta/test-notice-text";

/**
 * Настройки (docs/27-design-system-and-app-shell.md §6).
 *
 * Переключатель полноэкранного режима неактивен там, где клиент его не умеет,
 * и рядом написано почему: молча не работающий переключатель хуже, чем явно
 * выключенный (§5.2.1).
 */
export function SettingsScreen(): ReactNode {
  const navigation = useNavigation();
  const settings = useSettings();
  const diagnostics = useDiagnostics((state) => state.enabled);
  const graphics = useGraphics();
  const supportsFullscreen = useShell((state) => state.adapter.ui.supportsFullscreen);
  // Бот пишет только аккаунту и только там, где у площадки он есть.
  const botAvailable = useShell((state) => state.capabilities.auth !== undefined && state.capabilities.botUrl !== "");
  const bot = useBotNotifications();
  const [hintsReset, setHintsReset] = useState(false);

  return (
    <Screen title={t("settings.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <SectionTitle>{t("settings.screen")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("settings.fullscreen")}
            hint={supportsFullscreen ? undefined : t("settings.fullscreen.unsupported")}
            toggle={{
              checked: settings.screenMode === "fullscreen",
              disabled: !supportsFullscreen,
              onChange: () => {
                void settings.setScreenMode(
                  settings.screenMode === "fullscreen" ? "normal" : "fullscreen",
                );
              },
            }}
          />
        </ListGroup>

        <SectionTitle>{t("settings.sound")}</SectionTitle>
        <VolumeSliders />
        <div className="mt-3">
          <ListGroup>
            <ListItem
              title={t("settings.haptics")}
              toggle={{ checked: settings.haptics, onChange: () => settings.toggle("haptics") }}
            />
          </ListGroup>
        </div>

        {/* Как читать бой — за аккаунтом (Р56): выбранное здесь придёт и на
            другие устройства. Эффекты оружия — у устройства: их снимают,
            когда телефон не тянет. */}
        <SectionTitle>{t("settings.combat")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("settings.graphics.telegraphs")}
            hint={t("settings.graphics.telegraphs.hint")}
            toggle={{ checked: graphics.telegraphs, onChange: () => graphics.toggle("telegraphs") }}
          />
          <ListItem
            title={t("settings.graphics.damageNumbers")}
            toggle={{ checked: graphics.damageNumbers, onChange: () => graphics.toggle("damageNumbers") }}
          />
        </ListGroup>
        {/* Предупреждение обязательно: снятый телеграф — не «чуть проще
            картинка», а другой бой. Совет про слабое устройство — у графики:
            выбранное здесь уходит на все устройства. */}
        <p className="mt-2 text-xs text-text-muted">{t("settings.graphics.warning")}</p>
        <p className="mt-1 text-xs text-text-muted">{t("settings.scope.account")}</p>

        <SectionTitle>{t("settings.graphics")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("settings.graphics.weaponEffects")}
            hint={t("settings.graphics.weaponEffects.hint")}
            toggle={{ checked: graphics.weaponEffects, onChange: () => graphics.toggle("weaponEffects") }}
          />
        </ListGroup>
        <p className="mt-2 text-xs text-text-muted">{t("settings.scope.device")}</p>

        <SectionTitle>{t("settings.language")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("settings.language")}
            value={t("settings.language.value")}
            hint={t("settings.language.soon")}
            disabled
          />
        </ListGroup>

        <SectionTitle>{t("settings.hints")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("settings.hints.reset")}
            hint={hintsReset ? t("settings.hints.done") : undefined}
            onClick={() => {
              useHints.getState().reset();
              setHintsReset(true);
            }}
          />
        </ListGroup>

        {botAvailable ? (
          <>
            {/* Что дублировать в бота — за аккаунтом (Р51): решает сервер, когда
                пишет. Лента в игре получает всё независимо от этого выбора. */}
            <SectionTitle>{t("settings.bot")}</SectionTitle>
            <ListGroup>
              {BOT_NOTIFY_KEYS.map((key) => (
                <ListItem
                  key={key}
                  title={t(`settings.bot.${key}`)}
                  {...(key === "friendGift" ? { hint: t("settings.bot.friendGift.hint") } : {})}
                  toggle={{ checked: bot[key], onChange: () => noteAccountSetting(BOT_NOTIFY_ACCOUNT_KEYS[key], bot.toggle(key)) }}
                />
              ))}
            </ListGroup>
            <p className="mt-2 text-xs text-text-muted">{t("settings.bot.note")}</p>
            <p className="mt-1 text-xs text-text-muted">{t("settings.scope.account")}</p>
          </>
        ) : null}

        <SectionTitle>{t("settings.testers")}</SectionTitle>
        <ListGroup>
          <ListItem title={t("settings.testers")} onClick={() => navigation.push("testers")} />
          {diagnostics ? (
            <ListItem title={t("diagnostics.title")} onClick={() => navigation.push("diagnostics")} />
          ) : null}
          <ListItem title={t("settings.about")} onClick={() => navigation.push("about")} />
        </ListGroup>
      </ContentColumn>
    </Screen>
  );
}

/**
 * Громкость по регуляторам (docs/31-audio-and-haptics.md §5). Общая — поверх
 * всех; эффекты и интерфейс — отдельно: игрок вправе оставить бой и
 * убрать щелчки кнопок. Экспорт — для лаборатории звука, те же регуляторы.
 */
export function VolumeSliders(): ReactNode {
  const volumes = useSettings((state) => state.volumes);
  const keys: readonly VolumeKey[] = ["master", "effects", "ui"];
  return (
    <ListGroup>
      {keys.map((key) => (
        <Slider
          key={key}
          label={t(`settings.volume.${key}`)}
          value={volumes[key]}
          valueLabel={volumes[key] === 0 ? t("settings.volume.off") : `${volumes[key]}%`}
          onChange={(value) => useSettings.getState().setVolume(key, value)}
          onCommit={() => {
            useSettings.getState().commitVolume(key);
            // Интерфейс звучит своим щелчком, эффекты — попаданием: игрок
            // слышит ровно ту громкость, которую выставил.
            if (key === "ui" || key === "master") audio.ui("select");
          }}
        />
      ))}
    </ListGroup>
  );
}

/**
 * «Помощь в тестировании» (docs/35-stage4-plan.md Р56; docs/28-diagnostics.md
 * §2): для игрока, которого позвали помочь собрать игровые метрики, — что это
 * и что уходит команде. Участие и запись забегов — за аккаунтом, счётчик
 * кадров — у устройства. Сведения об устройстве открыты всем.
 */
export function TestersScreen(): ReactNode {
  const navigation = useNavigation();
  const diagnostics = useDiagnostics();
  const access = useToolsAccess();

  return (
    <Screen title={t("testers.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <p className="mb-3 text-sm text-text-muted">{t("testers.intro")}</p>
        <ListGroup>
          <ListItem
            title={t("testers.diagnostics")}
            hint={t("testers.diagnostics.hint")}
            toggle={{ checked: diagnostics.enabled, onChange: () => diagnostics.toggle("enabled") }}
          />
          <ListItem
            title={t("testers.recordRuns")}
            hint={t("testers.recordRuns.hint")}
            toggle={{
              checked: diagnostics.recordRuns,
              disabled: !diagnostics.enabled,
              onChange: () => diagnostics.toggle("recordRuns"),
            }}
          />
          <ListItem
            title={t("testers.fpsOverlay")}
            toggle={{
              checked: diagnostics.fpsOverlay,
              disabled: !diagnostics.enabled,
              onChange: () => diagnostics.toggle("fpsOverlay"),
            }}
          />
        </ListGroup>

        <div className="mt-4">
          <ListGroup>
            {/* Лаборатория звука — инструмент команды, а не тестера: она
                правит шины и мотивы, и услышанное там не то, что в игре. */}
            {access.admin ? (
              <ListItem
                title={t("testers.soundLab")}
                hint={t("testers.soundLab.hint")}
                onClick={() => navigation.push("soundLab")}
              />
            ) : null}
            {/* Сведения об устройстве — всем (Р56): поделиться ими с командой
                может любой игрок, а не только включивший диагностику. */}
            <ListItem title={t("testers.device")} hint={t("testers.device.hint")} onClick={() => navigation.push("diagnostics")} />
          </ListGroup>
        </div>
      </ContentColumn>
    </Screen>
  );
}

/**
 * «Об игре»: версия, сборка, предупреждение о тесте — его перечитывают, когда
 * вспоминают про вайп (docs/35-stage4-plan.md WP33), — и лицензии: атрибуция
 * ассетов обязательна.
 */
export function AboutScreen(): ReactNode {
  const navigation = useNavigation();
  const build = useShell((state) => state.build);
  const installId = useInstall((state) => state.installId);

  return (
    <Screen title={t("about.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {/* Бренд — здесь и на заставке, а не на главной (Р76). */}
        <div className="mt-2 mb-5 flex flex-col items-center gap-2 text-center">
          <Emblem size={64} />
          <Wordmark />
          <p className="max-w-[300px] text-sm text-text-muted">{t("lobby.tagline")}</p>
        </div>
        <ListGroup>
          <ListItem title={t("about.build")} value={build.version} />
          <ListItem title={t("about.content")} value={CONTENT_HASH} />
          <ListItem title={t("diagnostics.install")} value={installId.slice(0, 8)} />
        </ListGroup>

        <SectionTitle>{t("testNotice.title")}</SectionTitle>
        <TestNoticeText />

        <SectionTitle>{t("about.licenses")}</SectionTitle>
        <p className="text-xs text-text-muted">{t("about.licenses.text")}</p>
      </ContentColumn>
    </Screen>
  );
}
