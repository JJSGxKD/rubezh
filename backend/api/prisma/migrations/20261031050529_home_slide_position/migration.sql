-- Порядок слайдов команды на главной (T-0189, Р120): место слайда внутри своей
-- группы — закреплённые и остальные — задаётся перетаскиванием в панели.
-- Существующим слайдам место проставляется так, как игрок видит их сейчас:
-- позже начатый — выше. Снятые в порядок не входят и остаются с нулём.
ALTER TABLE "home_slide" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "home_slide" SET "position" = r.n
FROM (
    SELECT "slide_id", (ROW_NUMBER() OVER (PARTITION BY "pinned" ORDER BY "starts_at" DESC, "slide_id") - 1) AS n
    FROM "home_slide"
    WHERE "archived_at" IS NULL
) r
WHERE "home_slide"."slide_id" = r.slide_id;

ALTER TABLE "home_slide" ALTER COLUMN "position" DROP DEFAULT;

ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_position_check" CHECK ("position" >= 0);

CREATE INDEX "home_slide_pinned_position_idx" ON "home_slide"("pinned", "position");
