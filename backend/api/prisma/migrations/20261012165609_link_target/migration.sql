-- AlterEnum
ALTER TYPE "StartKind" ADD VALUE 'link';

-- AlterTable
ALTER TABLE "link" ADD COLUMN     "target" VARCHAR(16) NOT NULL DEFAULT 'app';
