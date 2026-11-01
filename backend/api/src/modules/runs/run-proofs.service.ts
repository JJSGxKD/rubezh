import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { runProofSchema } from "./dto/run-proof.dto.js";
import { RUN_PROOFS_REPOSITORY, type RunProofsRepository } from "./run-proofs.repository.js";
import { RUN_PROOF_LIMITS } from "./runs-limits.js";
import { RunNotFoundError } from "./runs-view.service.js";

/**
 * Приём записи забега для проверки (docs/35-stage4-plan.md WP5,
 * tasks/T-0317). Клиент шлёт её после записи забега: только к своему забегу,
 * без дублей. Здесь запись проверяется — размер до и после распаковки, форма,
 * принадлежность забегу и хэш контента — и кладётся в хранилище как есть, в
 * сжатом виде. Повтор и вердикт — T-0318, T-0319.
 *
 * Исход каждого приёма — строкой в лог (`run_proof_received`, поле `outcome`):
 * счётчик `run_proofs_received_total{outcome}` собирается из журналов, пока на
 * бэкенде нет своей выдачи метрик (docs/22-analytics-and-metrics.md §5.9). В
 * лог идут только вид исхода и вид причины — не сама запись.
 */

const gunzipAsync = promisify(gunzip);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DAY_MS = 86_400_000;
/** Шагов очистки за один запуск: страховка от бесконечного цикла, 100 тысяч записей в час с запасом. */
const MAX_CLEANUP_STEPS = 100;

/** Запись не принята: размер, форма, не тот забег или хэш; текст называет причину. */
export class RunProofInvalidError extends DomainError {
  constructor(message: string, readonly kind: string) {
    super("run_proof_invalid", message, 422);
  }
}

/** К этому забегу уже принята другая запись: заменить её нельзя. */
export class RunProofConflictError extends DomainError {
  constructor() {
    super("run_proof_conflict", "К этому забегу уже принята другая запись", 409);
  }
}

export type ProofReceipt = { status: "stored" | "duplicate"; keepUntil: string };

@Injectable()
export class RunProofsService {
  private readonly logger = new Logger("run-proofs");

  constructor(@Inject(RUN_PROOFS_REPOSITORY) private readonly repository: RunProofsRepository) {}

  /** Принять запись: 200 — принята или уже была та же, 404 — забег чужой или неизвестен, 409 — другая запись, 422 — не прошла проверку. */
  async receive(accountId: string, runId: string, encoded: string, now = new Date()): Promise<ProofReceipt> {
    try {
      const receipt = await this.accept(accountId, runId, encoded, now);
      this.outcome(receipt.status);
      return receipt;
    } catch (error: unknown) {
      if (error instanceof RunProofInvalidError) this.outcome("invalid", error.kind);
      else if (error instanceof RunProofConflictError) this.outcome("conflict");
      else if (error instanceof RunNotFoundError) this.outcome("not_found");
      throw error;
    }
  }

  /** Очистка: просроченные записи пачками; сколько удалено. Зовёт задание раз в час. */
  async cleanup(now = new Date(), batch: number = RUN_PROOF_LIMITS.cleanupBatch): Promise<number> {
    let removed = 0;
    for (let step = 0; step < MAX_CLEANUP_STEPS; step++) {
      const deleted = await this.repository.deleteExpired(now, batch);
      removed += deleted;
      if (deleted < batch) break;
    }
    if (removed > 0) this.logger.log(JSON.stringify({ module: "runs", event: "run_proofs_cleaned", removed }));
    return removed;
  }

  private async accept(accountId: string, runId: string, encoded: string, now: Date): Promise<ProofReceipt> {
    const run = await this.repository.ownRun(runId, accountId);
    // Чужой забег и несуществующий отвечают одинаково: наличие чужого забега не раскрываем.
    if (run === null) throw new RunNotFoundError();

    const packed = decode(encoded);
    const proof = await parse(packed);
    if (proof.input.truncated) throw new RunProofInvalidError("Лог ввода не влез в запись — такой забег не повторить", "input_truncated");
    if (proof.runId !== runId) throw new RunProofInvalidError("Запись относится к другому забегу", "run_mismatch");
    if (proof.contentHash !== run.contentHash) throw new RunProofInvalidError("Хэш контента записи не совпадает с забегом", "hash_mismatch");

    const keepUntil = new Date(now.getTime() + RUN_PROOF_LIMITS.keepDays * DAY_MS);
    if (await this.repository.insert(runId, packed, now, keepUntil)) return { status: "stored", keepUntil: keepUntil.toISOString() };

    // Запись уже есть: та же — повтор очереди клиента (200), другая — конфликт (409).
    const stored = await this.repository.find(runId);
    if (stored === null) return await this.accept(accountId, runId, encoded, now);
    if (await sameProof(stored.proof, packed, proof)) return { status: "duplicate", keepUntil: stored.keepUntil.toISOString() };
    throw new RunProofConflictError();
  }

  private outcome(outcome: string, kind?: string): void {
    this.logger.log(JSON.stringify({ module: "runs", event: "run_proof_received", outcome, ...(kind === undefined ? {} : { kind }) }));
  }
}

/** base64 → байты; потолок проверяется до декодирования, чтобы огромная строка не съела память. */
function decode(encoded: string): Buffer {
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) throw new RunProofInvalidError("Запись не в base64", "not_base64");
  const limit = RUN_PROOF_LIMITS.maxPackedBytes;
  if (encoded.length > Math.ceil(limit / 3) * 4) throw tooBig();
  const packed = Buffer.from(encoded, "base64");
  if (packed.byteLength > limit) throw tooBig();
  return packed;
}

const tooBig = (): RunProofInvalidError => new RunProofInvalidError(`Запись больше ${String(RUN_PROOF_LIMITS.maxPackedBytes / 1024)} КБ`, "packed_too_big");

/** gzip → JSON → схема. Потолок распакованного держит сам zlib: бомба не раздувается в памяти. */
async function parse(packed: Buffer) {
  let json: string;
  try {
    json = (await gunzipAsync(packed, { maxOutputLength: RUN_PROOF_LIMITS.maxUnpackedBytes })).toString("utf8");
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new RunProofInvalidError(`Распакованная запись больше ${String(RUN_PROOF_LIMITS.maxUnpackedBytes / 1024)} КБ`, "unpacked_too_big");
    }
    throw new RunProofInvalidError("Запись не распаковывается: нужен gzip", "not_gzip");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RunProofInvalidError("Запись не разбирается как JSON", "not_json");
  }
  const parsed = runProofSchema.safeParse(value);
  if (!parsed.success) {
    // Путь к первому полю, без значений: запись — данные игрока.
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    throw new RunProofInvalidError(`Запись не по форме${path === "" ? "" : `: поле ${path}`}`, "shape");
  }
  return parsed.data;
}

/** Та же запись: те же байты или тот же разобранный JSON (другое сжатие не делает запись другой). */
async function sameProof(stored: Uint8Array, incoming: Buffer, parsed: Awaited<ReturnType<typeof parse>>): Promise<boolean> {
  if (Buffer.from(stored).equals(incoming)) return true;
  try {
    return JSON.stringify(await parse(Buffer.from(stored))) === JSON.stringify(parsed);
  } catch {
    // Хранимое не разбирается (запись прошлой схемы) — считаем другим: заменять молча нельзя.
    return false;
  }
}
