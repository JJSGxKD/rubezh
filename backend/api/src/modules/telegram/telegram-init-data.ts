import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Проверка данных запуска Telegram Mini App (`initData`).
 *
 * Алгоритм — из документации Telegram: ключ — HMAC-SHA256 токена бота с
 * ключом `WebAppData`, подпись — HMAC-SHA256 от строки проверки, в которой
 * все поля, кроме `hash`, отсортированы по имени и склеены как `key=value`
 * через перевод строки. Сравнение подписи — за постоянное время.
 *
 * Возраст данных проверяется отдельно: подпись вечна, и перехваченная строка
 * без этой проверки годилась бы навсегда (docs/13-reuse-from-vpnsibcom.md §2.1 F).
 */

export interface TelegramPlayer {
  /** Telegram ID строкой: в JSON число больше 2^53 уже не представимо точно */
  id: string;
  name: string;
  username: string | null;
  photoUrl: string | null;
}

export type InitDataCheck =
  | { ok: true; player: TelegramPlayer; authDate: number }
  | { ok: false; reason: "missing_hash" | "bad_signature" | "expired" | "no_user" | "malformed" };

const userSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().max(128),
  last_name: z.string().max(128).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().url().max(512).optional(),
});

export function verifyInitData(
  raw: string,
  botToken: string,
  maxAgeSec: number,
  nowMs: number,
): InitDataCheck {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "missing_hash" };

  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return { ok: false, reason: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  // Небольшой запас в будущее: часы телефона и сервера расходятся.
  const ageSec = nowMs / 1000 - authDate;
  if (ageSec > maxAgeSec || ageSec < -300) return { ok: false, reason: "expired" };

  const userRaw = params.get("user");
  if (userRaw === null) return { ok: false, reason: "no_user" };

  let parsed: z.infer<typeof userSchema>;
  try {
    parsed = userSchema.parse(JSON.parse(userRaw));
  } catch {
    // Подпись верна, но поле пользователя не того вида — считаем данные битыми.
    return { ok: false, reason: "malformed" };
  }

  const name = [parsed.first_name, parsed.last_name].filter((part) => part !== undefined && part !== "").join(" ");
  return {
    ok: true,
    authDate,
    player: {
      id: String(parsed.id),
      name: name === "" ? (parsed.username ?? "Игрок") : name,
      username: parsed.username ?? null,
      photoUrl: parsed.photo_url ?? null,
    },
  };
}
