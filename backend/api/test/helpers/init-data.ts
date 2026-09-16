import { createHmac } from "node:crypto";

/** Подписать данные запуска так же, как это делает Telegram. */
export function signInitData(fields: Record<string, string>, token: string): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function launchFor(userId: number, token: string, nowMs = Date.now(), name = "Анна"): string {
  return signInitData(
    {
      auth_date: String(Math.floor(nowMs / 1000) - 60),
      query_id: "AAE",
      user: JSON.stringify({ id: userId, first_name: name, language_code: "ru" }),
    },
    token,
  );
}
