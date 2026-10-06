/**
 * Скрипт рекламной сети — при первом показе, а не при запуске: первая
 * загрузка игры их не ждёт, а игрок, которому реклама ни разу не нужна, их
 * и не скачает (docs/33-telegram-mini-app-pitfalls.md §6).
 *
 * Один адрес — одна загрузка: два показа подряд не вставят скрипт дважды.
 * Неудачная загрузка забывается — следующий показ попробует снова, а не
 * получит тот же отказ из памяти до перезапуска приложения.
 */

/** Сколько ждём скрипт сети: дольше — это уже не медленная сеть, а отказ. */
export const SCRIPT_TIMEOUT_MS = 15_000;

export interface ScriptLoader {
  /** `attributes` — как ждёт сеть: Taddy читает свой `pubId` из `data-pub-id` тега. */
  load(src: string, attributes?: Readonly<Record<string, string>>): Promise<void>;
}

/** Ровно то из DOM, что нужно загрузчику, — в тестах подменяется. */
export interface ScriptHost {
  append(src: string, attributes: Readonly<Record<string, string>>, done: (ok: boolean) => void): void;
}

/** Документ — по требованию: адаптер создаётся раньше, чем понадобится первый скрипт сети. */
export function documentScriptHost(document: () => Document): ScriptHost {
  return {
    append(src, attributes, done) {
      const doc = document();
      const script = doc.createElement("script");
      script.src = src;
      script.async = true;
      for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
      script.addEventListener("load", () => done(true), { once: true });
      script.addEventListener("error", () => done(false), { once: true });
      doc.head.append(script);
    },
  };
}

export function createScriptLoader(host: ScriptHost, timeoutMs = SCRIPT_TIMEOUT_MS): ScriptLoader {
  const loading = new Map<string, Promise<void>>();
  return {
    load(src, attributes = {}) {
      const known = loading.get(src);
      if (known !== undefined) return known;
      const promise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`скрипт ${src} не загрузился за ${String(timeoutMs)} мс`)), timeoutMs);
        host.append(src, attributes, (ok) => {
          clearTimeout(timer);
          if (ok) resolve();
          else reject(new Error(`скрипт ${src} не загрузился`));
        });
      });
      loading.set(src, promise);
      promise.catch(() => loading.delete(src));
      return promise;
    },
  };
}

let browserLoader: ScriptLoader | null = null;

/**
 * Загрузчик настоящего окна — один на приложение: SDK, поднятый для учёта
 * аудитории на старте, не вставляется второй раз при показе.
 */
export function browserScriptLoader(): ScriptLoader {
  browserLoader ??= createScriptLoader(documentScriptHost(() => document));
  return browserLoader;
}
