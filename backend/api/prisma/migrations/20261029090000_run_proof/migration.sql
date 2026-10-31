-- Запись забега для проверки (docs/35-stage4-plan.md WP5, tasks/T-0317):
-- сжатый RunProof, по которому сервер повторяет забег. Только добавление
-- (expand): новая таблица, старый код её не читает и не пишет.
-- Откат: DROP TABLE "run_proof" — после того как выкачен код без модуля;
-- записи — копия того, что клиент пошлёт заново, потерять их не страшно.
CREATE TABLE "run_proof" (
    "run_id" VARCHAR(64) NOT NULL,
    "proof" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "keep_until" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_proof_pkey" PRIMARY KEY ("run_id"),
    CONSTRAINT "run_proof_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 65536),
    CONSTRAINT "run_proof_keep_check" CHECK ("keep_until" > "received_at")
);

-- Очистка: просроченные, самые давние первыми.
CREATE INDEX "run_proof_keep_until_idx" ON "run_proof"("keep_until");

ALTER TABLE "run_proof" ADD CONSTRAINT "run_proof_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("run_id") ON DELETE CASCADE ON UPDATE CASCADE;
