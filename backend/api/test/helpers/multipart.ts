/**
 * Тело многочастного запроса к Bot API — обратно в `FormData`, как его поймёт
 * Telegram. grammY пишет части по-своему: заголовки без пробелов, имя файла
 * без кавычек, а сам файл — отдельной частью, на которую поле ссылается через
 * `attach://<id>`. Строгий разбор `Response.formData()` такого не принимает,
 * поэтому здесь свой, терпимый к тому же, к чему терпим Telegram, — и ссылки
 * `attach://` сразу разрешаются в файл.
 */
export async function multipartOf(init: RequestInit): Promise<FormData> {
  const type = new Headers(init.headers).get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  if (boundary === undefined) throw new Error(`не многочастный запрос: ${type}`);

  const raw = await bodyBytes(init.body);
  const parts = raw.toString("latin1").split(`--${boundary}`).slice(1, -1);

  const fields = new Map<string, string>();
  const files = new Map<string, File>();
  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n");
    const headers = part.slice(0, split);
    // Тело без завершающего перевода строки перед следующей границей.
    const content = Buffer.from(part.slice(split + 4, part.length - 2), "latin1");
    const name = /name="?([^";\r\n]+)"?/.exec(headers)?.[1] ?? "";
    const fileName = /filename="?([^";\r\n]+)"?/.exec(headers)?.[1];
    if (fileName === undefined) fields.set(name, content.toString("utf8"));
    else files.set(name, new File([new Uint8Array(content)], fileName));
  }

  const form = new FormData();
  for (const [name, value] of fields) {
    const attached = value.startsWith("attach://") ? files.get(value.slice("attach://".length)) : undefined;
    if (attached === undefined) form.set(name, value);
    else form.set(name, attached, attached.name);
  }
  return form;
}

async function bodyBytes(body: RequestInit["body"]): Promise<Buffer> {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.from(await new Response(body).arrayBuffer());
}
