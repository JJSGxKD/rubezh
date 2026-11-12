import { connect } from "node:http2";
import { decodeQueryStatsResponse, encodeQueryStatsRequest, grpcFrame, grpcUnframe, STATS_SERVICE_PATH, type StatEntry } from "@bh/proxy-kit";
import { STATS_TIMEOUT_MS } from "./traffic-rules.js";

/**
 * Чтение счётчиков службы статистики Xray (docs/35-stage4-plan.md Р192,
 * tasks/T-0386): один унарный вызов gRPC `QueryStats` поверх HTTP/2 без TLS по
 * сети `tunnel`, без зависимостей — запрос и разбор тела (`@bh/proxy-kit`,
 * `xray-stats.ts`) чистые, здесь только соединение.
 *
 * Чтение со сбросом: Xray отдаёт трафик с прошлого чтения и обнуляет счётчики
 * сам, поэтому реплики API читают без замка и не получают одни и те же байты.
 * Отсюда правило вызывающего: прочитанное нельзя терять, пока оно не записано.
 */

export type { StatEntry };

/** Адрес и тело ответа в тексте не пишутся: сообщение попадает в логи. */
export class XrayStatsUnavailableError extends Error {
  constructor(message = "Xray не отдал счётчики трафика") {
    super(message);
    this.name = "XrayStatsUnavailableError";
  }
}

export const STATS_SOURCE = Symbol("STATS_SOURCE");

/** Откуда берутся счётчики; в тестах подменяется. */
export interface StatsSource {
  /** Счётчики выходов со сбросом: прибавка с прошлого чтения. */
  query(reset: true): Promise<StatEntry[]>;
}

/** Все счётчики выходов; ответ — сотни записей, а мегабайт — потолок против чужого ответа. */
const PATTERN = "outbound>>>";
const RESPONSE_MAX_BYTES = 1_048_576;

export interface StatsClientOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export class Http2StatsSource implements StatsSource {
  constructor(private readonly options: StatsClientOptions) {}

  query(reset: true): Promise<StatEntry[]> {
    const { host, port, timeoutMs = STATS_TIMEOUT_MS } = this.options;
    return new Promise<StatEntry[]>((resolve, reject) => {
      const session = connect(`http://${host}:${port}`);
      let settled = false;
      const finish = (result: StatEntry[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Сессия живёт один вызов: раз в минуту открыть её дешевле, чем держать и следить за обрывом.
        session.destroy();
        if (result === null) reject(new XrayStatsUnavailableError());
        else resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      session.on("error", () => finish(null));

      try {
        const request = session.request({ ":method": "POST", ":path": STATS_SERVICE_PATH, "content-type": "application/grpc", te: "trailers" });
        const chunks: Buffer[] = [];
        let size = 0;
        let httpStatus: unknown;
        let headerStatus: unknown;
        let trailerStatus: unknown;
        request.on("response", (headers) => {
          httpStatus = headers[":status"];
          headerStatus = headers["grpc-status"];
        });
        request.on("trailers", (trailers) => {
          trailerStatus = trailers["grpc-status"];
        });
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > RESPONSE_MAX_BYTES) finish(null);
          else chunks.push(chunk);
        });
        request.on("error", () => finish(null));
        request.on("end", () => {
          // Статус — из трейлеров, а у ответа без тела — из заголовков.
          const status = trailerStatus ?? headerStatus;
          if (httpStatus !== 200 || String(status) !== "0") return finish(null);
          try {
            finish(decodeQueryStatsResponse(grpcUnframe(Buffer.concat(chunks))));
          } catch {
            finish(null);
          }
        });
        request.end(Buffer.from(grpcFrame(encodeQueryStatsRequest({ pattern: PATTERN, reset }))));
      } catch {
        finish(null);
      }
    });
  }
}
