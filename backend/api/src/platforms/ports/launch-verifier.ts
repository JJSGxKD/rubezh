import type { PlatformId } from "./platform.js";

/**
 * Проверка подписанных данных запуска (docs/35-stage4-plan.md, §3.11).
 *
 * Площадка отдаёт приложению строку, подписанную своим сервером, и только
 * проверенная строка говорит, кто играет: всё, что клиент сообщает о себе
 * сам, — заявление. Домену нужно, кто это, откуда пришёл и когда подписано;
 * чем и как площадка подписывает, он не знает.
 */

export interface LaunchPlayer {
  /** идентификатор на площадке — строкой: у Telegram он больше 2^53 */
  id: string;
  name: string;
  username: string | null;
  photoUrl: string | null;
}

export type LaunchCheck =
  | {
      ok: true;
      player: LaunchPlayer;
      /** когда площадка подписала запуск, секунды Unix */
      signedAtSec: number;
      /** параметр ссылки, по которой открыли игру, — из подписи, а не из тела запроса */
      startParam: string | null;
    }
  | {
      ok: false;
      /**
       * `expired` — подпись верна, но старая: игроку — открыть игру заново;
       * `invalid` — не наша подпись или битые данные; `unsupported` — площадка
       * не умеет или не настроена
       */
      reason: "expired" | "invalid" | "unsupported";
    };

export interface LaunchVerifier {
  readonly platform: PlatformId;
  /** схема заголовка `Authorization`, в которой клиент площадки шлёт подпись: у Telegram — `tma` */
  readonly authScheme: string;
  /** в окружении есть ключ, которым проверяется подпись */
  readonly configured: boolean;
  verify(raw: string, maxAgeSec: number, nowMs: number): LaunchCheck;
}

/** Проверки всех площадок: домен выбирает по площадке или по схеме заголовка, а не по имени класса. */
export class LaunchVerifiers {
  constructor(private readonly all: readonly LaunchVerifier[]) {}

  for(platform: PlatformId): LaunchVerifier | null {
    return this.all.find((verifier) => verifier.platform === platform) ?? null;
  }

  byScheme(scheme: string): LaunchVerifier | null {
    return this.all.find((verifier) => verifier.authScheme === scheme) ?? null;
  }
}
