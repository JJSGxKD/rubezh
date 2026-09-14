import { useState, type ReactNode } from "react";
import { CONTENT_HASH } from "@bh/core-game";
import {
  ContentColumn,
  ListGroup,
  ListItem,
  Screen,
  SectionTitle,
} from "../design-system/components";
import { t } from "../i18n";
import { useDiagnostics } from "../state/diagnostics";
import { useHints } from "../state/hints";
import { useInstall } from "../state/install";
import { useNavigation } from "../state/navigation";
import { usePlatform } from "../state/platform";
import { usePlaytestAccess } from "../state/playtest";
import { useSettings } from "../state/settings";
import { useShell } from "../state/shell";

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
  const supportsFullscreen = useShell((state) => state.adapter.ui.supportsFullscreen);
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
        <ListGroup>
          <ListItem
            title={t("settings.sound")}
            toggle={{ checked: settings.sound, onChange: () => settings.toggle("sound") }}
          />
          <ListItem
            title={t("settings.music")}
            toggle={{ checked: settings.music, onChange: () => settings.toggle("music") }}
          />
          <ListItem
            title={t("settings.haptics")}
            toggle={{ checked: settings.haptics, onChange: () => settings.toggle("haptics") }}
          />
        </ListGroup>
        <p className="mt-2 text-xs text-text-disabled">{t("settings.audio.soon")}</p>

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

/** «Для тестировщиков» — включатели режима диагностики (docs/28-diagnostics.md §2). */
export function TestersScreen(): ReactNode {
  const navigation = useNavigation();
  const diagnostics = useDiagnostics();

  return (
    <Screen title={t("testers.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
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

        {diagnostics.enabled ? (
          <div className="mt-4">
            <ListGroup>
              <ListItem title={t("testers.open")} onClick={() => navigation.push("diagnostics")} />
            </ListGroup>
          </div>
        ) : null}
      </ContentColumn>
    </Screen>
  );
}

/** «Об игре»: версия, сборка и лицензии — атрибуция ассетов обязательна. */
export function AboutScreen(): ReactNode {
  const navigation = useNavigation();
  const build = useShell((state) => state.build);
  const installId = useInstall((state) => state.installId);

  return (
    <Screen title={t("about.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <ListGroup>
          <ListItem title={t("about.build")} value={build.version} />
          <ListItem title={t("about.content")} value={CONTENT_HASH} />
          <ListItem title={t("diagnostics.install")} value={installId.slice(0, 8)} />
        </ListGroup>

        <SectionTitle>{t("about.licenses")}</SectionTitle>
        <p className="text-xs text-text-muted">{t("about.licenses.text")}</p>
      </ContentColumn>
    </Screen>
  );
}

/** Отступы и размеры — то, что чаще всего расходится между устройствами. */
export function DiagnosticsScreen(): ReactNode {
  const navigation = useNavigation();
  const access = usePlaytestAccess();
  const platform = usePlatform();
  const build = useShell((state) => state.build);

  return (
    <Screen title={t("diagnostics.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <SectionTitle>{t("diagnostics.device")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("diagnostics.device.screen")}
            value={`${platform.viewport.width}×${platform.viewport.height}`}
          />
          <ListItem
            title={t("diagnostics.device.pixelRatio")}
            value={String(globalThis.devicePixelRatio ?? 1)}
          />
          <ListItem
            title={t("diagnostics.device.cores")}
            value={String(navigator.hardwareConcurrency ?? 0)}
          />
          <ListItem title={t("diagnostics.device.platform")} value={build.platform} />
        </ListGroup>

        <SectionTitle>{t("diagnostics.insets")}</SectionTitle>
        <ListGroup>
          <ListItem
            title={t("diagnostics.insets")}
            value={`${platform.insets.top} / ${platform.insets.right} / ${platform.insets.bottom} / ${platform.insets.left}`}
          />
          <ListItem title={t("settings.fullscreen")} value={platform.screenMode} />
        </ListGroup>

        <SectionTitle>{t("diagnostics.runBench")}</SectionTitle>
        <ListGroup>
          {access.stressTest ? (
            <ListItem title={t("mode.stress")} onClick={() => navigation.push("stress")} />
          ) : null}
          <ListItem title={t("gallery.title")} onClick={() => navigation.push("gallery")} />
        </ListGroup>
        {access.stressTest ? null : <p className="mt-2 text-xs text-text-muted">{t("diagnostics.benchClosed")}</p>}
      </ContentColumn>
    </Screen>
  );
}
