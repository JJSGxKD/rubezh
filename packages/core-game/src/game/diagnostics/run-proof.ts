import type { DifficultyId, RunLoadout, RunMode, RunModifierId } from "@bh/shared-types";
import {
  RUN_PROOF_SCHEMA,
  type RunProof,
  type RunProofProgress,
  type RunRecordingResult,
  type RunReplayBlocker,
} from "../../run-api";
import { encodeBase64 } from "./input-log";

/**
 * Запись для проверки (docs/28-diagnostics.md §3.4, tasks/T-0316): сборка из того, что
 * записал рекордер, и упаковка для отправки. Файл не тянет ни симуляцию, ни Phaser:
 * упаковку берёт оболочка, и первая загрузка из-за неё не растёт.
 */

/** Потолок записи после сжатия; тот же держит приёмник (`RUN_PROOF_LIMITS.maxPackedBytes`). */
export const RUN_PROOF_MAX_PACKED_BYTES = 64 * 1024;

/** Шапка записи: то, с чем забег начался. Повтор строит по ней тот же мир, что сцена. */
export interface RunProofHeader {
  runId: string;
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  /** режим забега; у обычного забега поля нет */
  mode?: RunMode;
  /** модификатор забега (T-0119); у забега без него поля нет */
  modifierIds?: RunModifierId[];
  contentHash: string;
  unitScale: number;
  /** почему забег не повторить; `null` — повторяется. `input_overflow` и `proof_overflow` вычисляются позже. */
  replayBlocker: Exclude<RunReplayBlocker, "input_overflow" | "proof_overflow"> | null;
  /** набор на забег; у забега без снаряжения поля нет */
  loadout?: RunLoadout;
}

/**
 * Запись для проверки из шапки, хода и итога. Ход копируется: рекордер после сборки
 * ничего не меняет, но запись уходит в очередь отправки и живёт дольше него.
 *
 * Класс устройства уходит отдельным полем и снимается с набора: приёмник держит его на
 * верхнем уровне, и набор в записи равен набору из схемы приёмника.
 */
export function buildRunProof(header: RunProofHeader, progress: RunProofProgress, result: RunRecordingResult): RunProof {
  const { deviceClass, ...loadout } = header.loadout ?? { modifiers: {}, boosts: [] };
  return {
    schema: RUN_PROOF_SCHEMA,
    runId: header.runId,
    seed: header.seed,
    mapId: header.mapId,
    difficultyId: header.difficultyId,
    mode: header.mode ?? "endless",
    ...(header.modifierIds === undefined || header.modifierIds.length === 0 ? {} : { modifierIds: [...header.modifierIds] }),
    startingWeaponId: header.startingWeaponId,
    contentHash: header.contentHash,
    unitScale: header.unitScale,
    loadout: { ...loadout, modifiers: { ...loadout.modifiers }, boosts: [...loadout.boosts] },
    deviceClass: deviceClass ?? "standard",
    input: { ...progress.input },
    choices: progress.choices.map(([tick, optionId]) => [tick, optionId]),
    continues: [...progress.continues],
    checkpoints: progress.checkpoints.map(([tick, checksum]) => [tick, checksum]),
    result: { ...result },
  };
}

/** Упакованная запись: gzip в base64 — ровно то, что уходит в теле `PUT /api/v1/runs/:runId/proof`. */
export type PackedRunProof = { ok: true; payload: string; bytes: number } | { ok: false; blocker: "proof_overflow" };

/**
 * Сжать запись для отправки. Больше потолка после сжатия — `proof_overflow`: такую запись
 * приёмник всё равно отверг бы, и слать её незачем. Сжатие — `CompressionStream`, он есть в
 * браузерах площадок; где его нет, функция бросает, и оболочка считает запись неотправленной.
 */
export async function packRunProof(proof: RunProof): Promise<PackedRunProof> {
  const json = new TextEncoder().encode(JSON.stringify(proof));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.byteLength > RUN_PROOF_MAX_PACKED_BYTES) return { ok: false, blocker: "proof_overflow" };
  return { ok: true, payload: encodeBase64(bytes), bytes: bytes.byteLength };
}
