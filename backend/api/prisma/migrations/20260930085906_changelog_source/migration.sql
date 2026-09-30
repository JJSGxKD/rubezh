-- CreateTable
CREATE TABLE "changelog_source" (
    "source_key" VARCHAR(64) NOT NULL,
    "entry_id" UUID,
    "imported_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "changelog_source_pkey" PRIMARY KEY ("source_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "changelog_source_entry_id_key" ON "changelog_source"("entry_id");

-- AddForeignKey
ALTER TABLE "changelog_source" ADD CONSTRAINT "changelog_source_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "changelog_entry"("entry_id") ON DELETE SET NULL ON UPDATE CASCADE;
