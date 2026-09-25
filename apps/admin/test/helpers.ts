import type { FetchLike } from "../src/api/client";

export interface Call {
  url: string;
  init: RequestInit;
}

/** Поддельный `fetch`: отвечает по очереди заранее заданными ответами и запоминает запросы. */
export function fakeFetch(...responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("поддельный fetch: ответы кончились");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const IDENTITY = {
  account: { accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f", platform: "telegram", displayName: "Разработчик", photoUrl: null },
  roles: ["owner"],
  permissions: ["players.view", "players.ban"],
};
