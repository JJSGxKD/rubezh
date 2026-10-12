/** Адрес из `req.ip` Fastify: он учитывает число доверенных прокси, а сырой заголовок подделывается одной строкой. */
export function addressOf(request: unknown): string {
  if (typeof request === "object" && request !== null && "ip" in request && typeof request.ip === "string" && request.ip !== "") return request.ip;
  return "unknown";
}
