import { packRunProof, type RunProof } from "@bh/core-game";
import type { KeyValueStorage } from "@bh/shared-types";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure } from "./api-request";
import { reportError, useShell } from "./shell";

/**
 * Очередь записей для проверки на устройстве (docs/28-diagnostics.md §3.4, tasks/T-0316).
 *
 * Запись для проверки есть у каждого забега: по ней сервер повторяет забег и сверяет исход.
 * Она уходит **после того, как сервер записал забег** — приёмник принимает её только к
 * своему забегу. Игрок ничего не ждёт: забег уже записан, а запись досылается в фоне.
 *
 * Очередь живёт в хранилище устройства: закрыть приложение можно в любую секунду, а сети
 * бывает нет сутками. В ней не больше трёх записей — новая вытесняет самую старую, — и
 * запись старше трёх суток выбрасывается: приёмник хранит их неделю, и поздняя не нужна.
 * Повтор безопасен: приёмник на ту же запись отвечает «уже есть».
 *
 * Ошибки хранилища — не причина терять забег: очередь работает и из памяти.
 */

export const RUN_PROOF_QUEUE_KEY = "bh.runs.v1.proofs";
export const RUN_PROOF_QUEUE_MAX_ITEMS = 3;
export const RUN_PROOF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Сколько ответов сервера помнить для записей, которые ещё сжимаются и в очередь не встали. */
const RECORDED_MEMORY = 10;

export type ProofSendResult = { ok: true } | { ok: false; failure: ApiFailure; code?: string };

/** Почему запись выброшена: сервер отверг, уже принята другая, вышел срок, вытеснена новой. */
export type ProofDropReason = "rejected" | "conflict" | "expired" | "evicted";

export interface RunProofQueueDeps {
  storage: KeyValueStorage | undefined;
  send(runId: string, payload: string): Promise<ProofSendResult>;
  onDropped?(runId: string, reason: ProofDropReason): void;
  now?: () => number;
}

export interface RunProofQueue {
  /** Положить сжатую запись (base64). Уходит, когда сервер подтвердит забег (`recorded`). */
  enqueue(runId: string, payload: string): void;
  /** Сервер записал этот забег — его запись можно отправлять. */
  recorded(runId: string): void;
  /** Отправить всё, что можно; сеть и сервер не ответили — остаётся до следующего раза. */
  flush(): Promise<void>;
  state(): { pending: { runId: string; recorded: boolean; queuedAtMs: number }[] };
}

const entrySchema = z.object({ runId: z.string(), payload: z.string(), queuedAtMs: z.number(), recorded: z.boolean() });
type Entry = z.infer<typeof entrySchema>;
const queueSchema = z.array(entrySchema);

export function createRunProofQueue(deps: RunProofQueueDeps): RunProofQueue {
  const now = deps.now ?? (() => Date.now());
  let entries: Entry[] = [];
  /** подтверждения сервера, пришедшие раньше записи: сжатие идёт дольше, чем иногда отвечает сеть */
  const recordedRuns: string[] = [];
  let sending = false;

  const save = (): void => {
    try {
      deps.storage?.set(RUN_PROOF_QUEUE_KEY, JSON.stringify(entries));
    } catch {
      // Хранилище недоступно: очередь живёт из памяти до закрытия приложения, а забег записан.
    }
  };

  const drop = (entry: Entry, reason: ProofDropReason): void => {
    entries = entries.filter((item) => item.runId !== entry.runId);
    deps.onDropped?.(entry.runId, reason);
  };

  const dropExpired = (): void => {
    const limit = now() - RUN_PROOF_MAX_AGE_MS;
    const expired = entries.filter((entry) => entry.queuedAtMs < limit);
    if (expired.length === 0) return;
    for (const entry of expired) drop(entry, "expired");
    save();
  };

  entries = readEntries(deps.storage);
  dropExpired();

  const flush = async (): Promise<void> => {
    if (sending) return;
    sending = true;
    try {
      dropExpired();
      for (;;) {
        const entry = entries.find((item) => item.recorded);
        if (entry === undefined) break;
        const result = await deps.send(entry.runId, entry.payload);
        if (result.ok) {
          entries = entries.filter((item) => item.runId !== entry.runId);
          save();
          continue;
        }
        // Сервер отверг запись или уже принял другую: повтор не поможет, а застрявшая
        // первой она держала бы остальные.
        if (result.failure === "rejected" || result.code === "run_proof_conflict") {
          drop(entry, result.failure === "rejected" ? "rejected" : "conflict");
          save();
          continue;
        }
        // Сеть, сессия, сервер: пройдёт само — ждём следующего раза.
        break;
      }
    } finally {
      sending = false;
    }
  };

  return {
    enqueue(runId, payload): void {
      dropExpired();
      const next: Entry = { runId, payload, queuedAtMs: now(), recorded: recordedRuns.includes(runId) };
      const queued = [...entries.filter((entry) => entry.runId !== runId), next];
      for (const evicted of queued.slice(0, -RUN_PROOF_QUEUE_MAX_ITEMS)) deps.onDropped?.(evicted.runId, "evicted");
      entries = queued.slice(-RUN_PROOF_QUEUE_MAX_ITEMS);
      save();
      void flush();
    },

    recorded(runId): void {
      const entry = entries.find((item) => item.runId === runId);
      if (entry === undefined) {
        if (!recordedRuns.includes(runId)) recordedRuns.push(runId);
        if (recordedRuns.length > RECORDED_MEMORY) recordedRuns.shift();
      } else if (!entry.recorded) {
        entries = entries.map((item) => (item.runId === runId ? { ...item, recorded: true } : item));
        save();
      }
      void flush();
    },

    flush,

    state: () => ({ pending: entries.map(({ runId, recorded, queuedAtMs }) => ({ runId, recorded, queuedAtMs })) }),
  };
}

/**
 * Очередь с диска. Значение из хранилища — граница системы: его пишет прошлая версия
 * приложения или портит приватный режим, поэтому оно читается схемой, а битое сбрасывается.
 */
function readEntries(storage: KeyValueStorage | undefined): Entry[] {
  try {
    const raw = storage?.get(RUN_PROOF_QUEUE_KEY) ?? null;
    if (raw === null) return [];
    const parsed = queueSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.slice(-RUN_PROOF_QUEUE_MAX_ITEMS);
    storage?.remove(RUN_PROOF_QUEUE_KEY);
  } catch {
    try {
      storage?.remove(RUN_PROOF_QUEUE_KEY);
    } catch {
      // Битое значение не снять, но и не прочесть: очередь начинается пустой.
    }
  }
  return [];
}

const receiptSchema = z.object({ status: z.enum(["stored", "duplicate"]), keepUntil: z.string() });

async function sendProof(runId: string, payload: string): Promise<ProofSendResult> {
  const answer = await apiRequest(`/api/v1/runs/${encodeURIComponent(runId)}/proof`, receiptSchema, { method: "PUT", body: { proof: payload } });
  if (answer.ok) return { ok: true };
  return { ok: false, failure: answer.failure, ...(answer.code === undefined ? {} : { code: answer.code }) };
}

let shared: { storage: KeyValueStorage | undefined; queue: RunProofQueue } | null = null;

/** Одна очередь на приложение: забег и досылка при запуске видят одно и то же. */
export function runProofs(): RunProofQueue {
  const storage = useShell.getState().storage;
  if (shared === null || shared.storage !== storage) {
    shared = {
      storage,
      queue: createRunProofQueue({
        storage,
        send: sendProof,
        // Устаревшая и вытесненная запись — обычная жизнь очереди; отвергнутая сервером — дефект формата.
        onDropped: (runId, reason) => {
          if (reason === "rejected") reportError("proofs", `запись для проверки забега ${runId} отвергнута сервером`);
        },
      }),
    };
  }
  return shared.queue;
}

/**
 * Запись для проверки забега, только что законченного: сжать и поставить в очередь. Сборка
 * без входа (MAX, VK, тесты) отправить её не может, и сжимать незачем. Сжатие асинхронно —
 * движок отдаёт запись сразу, а забег давно записан.
 */
export async function queueRunProof(proof: RunProof): Promise<void> {
  if (useShell.getState().capabilities.auth === undefined) return;
  const packed = await packRunProof(proof);
  if (!packed.ok) {
    reportError("proofs", `запись забега ${proof.runId} не отправлена: ${packed.blocker}`);
    return;
  }
  runProofs().enqueue(proof.runId, packed.payload);
}
