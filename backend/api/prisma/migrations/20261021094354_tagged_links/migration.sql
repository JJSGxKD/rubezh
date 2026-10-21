-- AlterEnum
ALTER TYPE "StartKind" ADD VALUE 'tagged';

-- AlterTable
ALTER TABLE "link" ADD COLUMN     "auto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auto_key" VARCHAR(64),
ADD COLUMN     "hidden_at" TIMESTAMPTZ(3),
ADD COLUMN     "partner_tag" VARCHAR(64),
ADD COLUMN     "title" VARCHAR(80);

-- CreateTable
CREATE TABLE "start_param_key" (
    "key" VARCHAR(16) NOT NULL,
    "hits" INTEGER NOT NULL,
    "first_at" TIMESTAMPTZ(3) NOT NULL,
    "last_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "start_param_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "link_auto_key_key" ON "link"("auto_key");

