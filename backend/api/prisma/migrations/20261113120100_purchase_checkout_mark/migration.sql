-- AlterTable
ALTER TABLE "purchase" ADD COLUMN     "checkout_at" TIMESTAMPTZ(3),
ADD COLUMN     "checkout_refusal" VARCHAR(32);

