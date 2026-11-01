-- CreateEnum
CREATE TYPE "NameCandidateKind" AS ENUM ('word', 'pair');

-- CreateTable
CREATE TABLE "name_rule_candidate" (
    "candidate_id" UUID NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "kind" "NameCandidateKind" NOT NULL,
    "players" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    "dismissed_at" TIMESTAMPTZ(3),
    "dismissed_by" UUID,

    CONSTRAINT "name_rule_candidate_pkey" PRIMARY KEY ("candidate_id")
);

-- CreateIndex
CREATE INDEX "name_rule_candidate_players_idx" ON "name_rule_candidate"("players");

-- CreateIndex
CREATE UNIQUE INDEX "name_rule_candidate_kind_token_key" ON "name_rule_candidate"("kind", "token");
