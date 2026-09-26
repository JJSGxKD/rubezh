-- AlterTable
ALTER TABLE "link" ADD COLUMN     "share_kind" VARCHAR(16),
ADD COLUMN     "share_ref" VARCHAR(64),
ADD COLUMN     "shared_by" UUID;

-- CreateIndex
CREATE INDEX "link_shared_by_created_at_idx" ON "link"("shared_by", "created_at");

