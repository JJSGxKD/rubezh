/**
 * Случайный идентификатор: установки, захода, события.
 *
 * `crypto.randomUUID` есть не во всех WebView. Запасной путь — случайные
 * байты из `crypto` (32 шестнадцатеричных знака, сервер принимает оба вида),
 * и только если нет и его, `Math.random`: это не симуляция, детерминизм здесь
 * не нужен.
 */
export function createId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
