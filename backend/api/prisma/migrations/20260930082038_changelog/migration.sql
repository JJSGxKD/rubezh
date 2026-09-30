-- CreateEnum
CREATE TYPE "ChangelogKind" AS ENUM ('added', 'changed', 'fixed');

-- CreateTable
CREATE TABLE "changelog_entry" (
    "entry_id" UUID NOT NULL,
    "version" VARCHAR(16) NOT NULL,
    "version_major" INTEGER NOT NULL,
    "version_minor" INTEGER NOT NULL,
    "version_patch" INTEGER NOT NULL,
    "platforms" "Platform"[],
    "kind" "ChangelogKind" NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "changelog_entry_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "changelog_release" (
    "version" VARCHAR(16) NOT NULL,
    "platforms" "Platform"[],
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "cursor" UUID,
    "done_at" TIMESTAMPTZ(3),

    CONSTRAINT "changelog_release_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "changelog_seen" (
    "account_id" UUID NOT NULL,
    "seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "changelog_seen_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "changelog_entry_version_idx" ON "changelog_entry"("version");

-- AddForeignKey
ALTER TABLE "changelog_seen" ADD CONSTRAINT "changelog_seen_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Версия — строкой для показа и числами для порядка; разойтись им нельзя,
-- иначе журнал показал бы `0.6.0` на месте `0.10.0`. Пустая строка журнала —
-- не изменение.
ALTER TABLE "changelog_entry" ADD CONSTRAINT "changelog_entry_version_parts" CHECK ("version" = "version_major" || '.' || "version_minor" || '.' || "version_patch");
ALTER TABLE "changelog_entry" ADD CONSTRAINT "changelog_entry_text_not_blank" CHECK (btrim("text") <> '');
