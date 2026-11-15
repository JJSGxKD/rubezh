-- Контент игры на сервере (tasks/T-0303, docs/19-content-admin.md §3): версии снимка,
-- черновики поверх версий и проверки черновиков в sim-worker. Только новые таблицы:
-- код прошлого релиза на такой схеме работает.

-- CreateTable
CREATE TABLE "content_version" (
    "version_no" SERIAL NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "schema_version" SMALLINT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "json_schema" JSONB NOT NULL,
    "names" JSONB NOT NULL,
    "source" VARCHAR(8) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "content_version_pkey" PRIMARY KEY ("version_no")
);

-- CreateTable
CREATE TABLE "content_draft" (
    "draft_id" UUID NOT NULL,
    "base_version_no" INTEGER NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "author" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "content_draft_pkey" PRIMARY KEY ("draft_id")
);

-- CreateTable
CREATE TABLE "content_check" (
    "check_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(8) NOT NULL,
    "report" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_check_pkey" PRIMARY KEY ("check_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_version_content_hash_key" ON "content_version"("content_hash");

-- CreateIndex
CREATE INDEX "content_draft_updated_at_idx" ON "content_draft"("updated_at");

-- CreateIndex
CREATE INDEX "content_draft_base_version_no_idx" ON "content_draft"("base_version_no");

-- CreateIndex
CREATE INDEX "content_check_draft_id_created_at_idx" ON "content_check"("draft_id", "created_at");

-- AddForeignKey
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_base_version_no_fkey" FOREIGN KEY ("base_version_no") REFERENCES "content_version"("version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_check" ADD CONSTRAINT "content_check_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "content_draft"("draft_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Источник версии и статус проверки — из списка: опечатка в коде не должна стать
-- третьим значением, которое панель не умеет показать.
ALTER TABLE "content_version" ADD CONSTRAINT "content_version_source_check" CHECK ("source" IN ('repo', 'panel'));
ALTER TABLE "content_check" ADD CONSTRAINT "content_check_status_check" CHECK ("status" IN ('queued', 'done', 'failed', 'timeout'));

-- Один живой отчёт на пару (черновик, снимок): повтор проверки того же снимка отдаёт
-- прошлый, а гонка двух запросов не заводит второй. Упавшая проверка место не занимает —
-- её повторяют.
CREATE UNIQUE INDEX "content_check_live_key" ON "content_check"("draft_id", "snapshot_hash") WHERE "status" <> 'failed';
