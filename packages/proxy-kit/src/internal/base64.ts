/**
 * base64 обеих азбук (обычной и URL-safe), с `=` и без. `null` — строка не
 * base64: `Buffer.from` молча выбрасывает чужие знаки, а подписке нужно
 * отличать закодированное от открытого текста.
 */
const BASE64_BODY = /^[A-Za-z0-9+/_-]*={0,2}$/;

export function decodeBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || !BASE64_BODY.test(compact)) return null;
  // Длина, кратная 4 после выкидывания `=`, невозможна: остаток 1 знак — не base64.
  if (compact.replace(/=+$/, "").length % 4 === 1) return null;
  const decoded = Buffer.from(compact, "base64").toString("utf8");
  return decoded.includes("�") ? null : decoded;
}
