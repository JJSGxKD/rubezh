-- AlterEnum
ALTER TYPE "PurchaseProduct" ADD VALUE 'vip';

-- AlterTable
ALTER TABLE "purchase" ADD COLUMN "renewal_of" UUID;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_renewal_of_fkey" FOREIGN KEY ("renewal_of") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;
