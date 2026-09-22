import { audio, installAudioUnlock, type SoundScene } from "../audio";
import { currentScreen, useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useRun, type RunPhase } from "./run";
import { useSettings } from "./settings";
import { useShell } from "./shell";

/**
 * Звук следует за оболочкой (docs/31-audio-and-haptics.md §3): громкость — за
 * настройками, пауза звука — за сворачиванием приложения, сцена звука — за
 * экраном и фазой забега. Сам звук об этих сторах не знает.
 */
export function startAudioSync(): () => void {
  const stopUnlock = installAudioUnlock(useShell.getState().storage);
  audio.setVolumes(useSettings.getState().volumes);

  const unsubscribes = [
    useSettings.subscribe((state, previous) => {
      if (state.volumes !== previous.volumes) audio.setVolumes(state.volumes);
    }),
    usePlatform.subscribe((state, previous) => {
      if (state.isActive !== previous.isActive) audio.setActive(state.isActive);
    }),
    useNavigation.subscribe(() => audio.setScene(sceneNow())),
    useRun.subscribe((state, previous) => {
      if (state.phase !== previous.phase) audio.setScene(sceneNow());
    }),
  ];
  audio.setScene(sceneNow());

  return () => {
    stopUnlock();
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export function sceneFor(screen: string, runOnStack: boolean, phase: RunPhase): SoundScene {
  // Стресс-тест меряет устройство: звук отнимал бы у замера процессор.
  if (screen === "stress") return "silent";
  if (screen !== "run" && !runOnStack) return "lobby";
  // Настройки поверх забега — это всё ещё пауза забега, а не главная.
  switch (phase) {
    case "running":
    case "loading":
      return screen === "run" ? "run" : "pause";
    case "paused":
      return "pause";
    case "levelUp":
      return "choice";
    case "finished":
      return "finished";
    default:
      return "lobby";
  }
}

function sceneNow(): SoundScene {
  const stack = useNavigation.getState().stack;
  return sceneFor(currentScreen(stack), stack.includes("run"), useRun.getState().phase);
}
