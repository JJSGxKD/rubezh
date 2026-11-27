-- Материалы для партнёров (docs/35-stage4-plan.md Р136, tasks/T-0221): баннеры,
-- тексты постов и правила программы, которые выкладывает команда. Общий
-- материал — без `partner_id`, адресный — с ним. Архивный партнёру не виден,
-- но запись остаётся.
CREATE TABLE "partner_material" (
    "material_id" UUID NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "text" VARCHAR(2000),
    "image_id" VARCHAR(64),
    "partner_id" UUID,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "partner_material_pkey" PRIMARY KEY ("material_id")
);

-- Кабинет берёт общие и свои неархивные: список короткий, но идёт на каждое открытие вкладки.
CREATE INDEX "partner_material_partner_id_archived_at_idx" ON "partner_material"("partner_id", "archived_at");

-- Пока на картинку ссылается материал, удалить её нельзя; партнёра с материалами — тоже.
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media_image"("image_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("partner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Те же правила, что держит сервис (`partners/partner-materials.ts`): строка в обход панели не заведёт
-- баннер без картинки, пост без текста или текст с картинкой.
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_kind_check" CHECK ("kind" IN ('banner', 'post', 'rules'));
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_shape_check" CHECK (
    ("kind" = 'banner' AND "image_id" IS NOT NULL)
    OR ("kind" IN ('post', 'rules') AND "image_id" IS NULL AND "text" IS NOT NULL AND btrim("text") <> '')
);
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_title_check" CHECK (btrim("title") <> '');
ALTER TABLE "partner_material" ADD CONSTRAINT "partner_material_sort_check" CHECK ("sort" BETWEEN 0 AND 9999);
