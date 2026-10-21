-- AlterTable
ALTER TABLE "link" ADD COLUMN     "partner_id" UUID;

-- AlterTable
ALTER TABLE "partner_binding" ADD COLUMN     "link_code" VARCHAR(16);

-- CreateIndex
CREATE INDEX "link_partner_id_idx" ON "link"("partner_id");

-- AddForeignKey
ALTER TABLE "link" ADD CONSTRAINT "link_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partner"("partner_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_binding" ADD CONSTRAINT "partner_binding_link_code_fkey" FOREIGN KEY ("link_code") REFERENCES "link"("code") ON DELETE SET NULL ON UPDATE CASCADE;
