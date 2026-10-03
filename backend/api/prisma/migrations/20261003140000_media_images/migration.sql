-- Картинки из панели (docs/35-stage4-plan.md О42): в базе до CDN. id —
-- SHA-256 содержимого, поэтому адрес картинки вечный и кешируется навсегда,
-- а при переезде на CDN не меняется. Строка не меняется никогда.
CREATE TABLE "media_image" (
    "image_id" VARCHAR(64) NOT NULL,
    "content_type" VARCHAR(32) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "media_image_pkey" PRIMARY KEY ("image_id")
);

-- То же, что проверяет сервер (`media/image-rules.ts`): запись в обход
-- сервиса не положит в базу то, что потом отдастся игрокам.
ALTER TABLE "media_image" ADD CONSTRAINT "media_image_id_check" CHECK ("image_id" ~ '^[0-9a-f]{64}$');
ALTER TABLE "media_image" ADD CONSTRAINT "media_image_content_type_check" CHECK ("content_type" = 'image/webp');
ALTER TABLE "media_image" ADD CONSTRAINT "media_image_size_check" CHECK ("size_bytes" BETWEEN 1 AND 204800 AND "size_bytes" = octet_length("data"));
ALTER TABLE "media_image" ADD CONSTRAINT "media_image_sides_check" CHECK ("width" BETWEEN 1 AND 4096 AND "height" BETWEEN 1 AND 4096);

-- WebP уже сжат: второе сжатие TOAST тратило бы процессор впустую.
ALTER TABLE "media_image" ALTER COLUMN "data" SET STORAGE EXTERNAL;
