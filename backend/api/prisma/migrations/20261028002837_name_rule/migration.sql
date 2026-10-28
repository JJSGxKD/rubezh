-- CreateEnum
CREATE TYPE "NameRuleCategory" AS ENUM ('profanity', 'brand', 'ads', 'other', 'allow');

-- CreateEnum
CREATE TYPE "NameRuleKind" AS ENUM ('exact', 'word', 'regex');

-- CreateTable
CREATE TABLE "name_rule" (
    "rule_id" UUID NOT NULL,
    "category" "NameRuleCategory" NOT NULL,
    "kind" "NameRuleKind" NOT NULL,
    "pattern" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "name_rule_pkey" PRIMARY KEY ("rule_id")
);

-- CreateIndex
CREATE INDEX "name_rule_active_idx" ON "name_rule"("active");

-- CreateIndex
CREATE UNIQUE INDEX "name_rule_category_kind_pattern_key" ON "name_rule"("category", "kind", "pattern");
