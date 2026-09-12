/**
 * Идентификатор забега или прогона стенда.
 *
 * Генерируется один раз на забег и живёт в `runId` итога и в `reportId`
 * отчёта стенда. Это ключ идемпотентности для приёмника: у человека есть
 * кнопка «отправить ещё раз» на случай обрыва сети, и без ключа повторные
 * нажатия наплодили бы дубликаты. Хэш тела в этой роли не годится — два
 * прогона на одном устройстве с одним seed могут совпасть до байта.
 *
 * Живёт вне `game/sim/*`: `Math.random` в запасной ветке запрещён в
 * симуляции, а идентификатор на её результат не влияет.
 */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;

  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    // Крайний случай для старых WebView. Это идентификатор, а не секрет:
    // от него требуется уникальность в пределах наших прогонов, не более.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Версия 4 и вариант 1 — иначе схема на сервере не примет строку как UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
