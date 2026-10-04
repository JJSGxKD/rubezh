-- Слайды команды в карусели главной (docs/35-stage4-plan.md WP42, часть 2):
-- анонс от команды — заголовок и подпись по строке, картинка 1:1 или значок,
-- куда ведёт, кому и на какой срок. Снятый слайд не удаляется: его история
-- — в разделе панели и в аудите.
CREATE TABLE "home_slide" (
    "slide_id" UUID NOT NULL,
    "title" VARCHAR(32) NOT NULL,
    "text" VARCHAR(40) NOT NULL,
    "image_id" VARCHAR(64),
    "icon" VARCHAR(16) NOT NULL,
    "target_kind" VARCHAR(8) NOT NULL,
    "target_screen" VARCHAR(16),
    "target_url" VARCHAR(256),
    "platforms" "Platform"[],
    "audience" VARCHAR(16) NOT NULL,
    "pinned" BOOLEAN NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by" UUID,

    CONSTRAINT "home_slide_pkey" PRIMARY KEY ("slide_id")
);

-- Главная берёт слайды, срок которых ещё не вышел: их единицы, а не вся история.
CREATE INDEX "home_slide_ends_at_idx" ON "home_slide"("ends_at");

-- Пока слайд ссылается на картинку, удалить её нельзя.
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media_image"("image_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Те же правила, что держит сервис (`home/team-slide-rules.ts`): строка в
-- обход панели не заведёт слайд, который ведёт в никуда или не кончается.
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_target_check" CHECK (
    ("target_kind" = 'screen' AND "target_screen" IS NOT NULL AND "target_url" IS NULL)
    OR ("target_kind" = 'link' AND "target_url" ~ '^https://' AND "target_screen" IS NULL)
);
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_term_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_platforms_check" CHECK ("platforms" IS NOT NULL AND cardinality("platforms") > 0);
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_audience_check" CHECK ("audience" IN ('all', 'newbies', 'payers', 'nonpayers', 'vip'));
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_icon_check" CHECK ("icon" ~ '^[a-z]{2,16}$');
ALTER TABLE "home_slide" ADD CONSTRAINT "home_slide_archive_check" CHECK (("archived_at" IS NULL) = ("archived_by" IS NULL));
