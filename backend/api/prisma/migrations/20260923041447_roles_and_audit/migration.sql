-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'game_designer', 'moderator', 'marketer', 'finance', 'analyst', 'stakeholder');

-- CreateTable
CREATE TABLE "account_role" (
    "account_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_role_pkey" PRIMARY KEY ("account_id","role")
);

-- CreateTable
CREATE TABLE "audit_entry" (
    "entry_id" UUID NOT NULL,
    "actor_account_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "target" VARCHAR(128),
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("entry_id")
);

-- CreateIndex
CREATE INDEX "account_role_role_idx" ON "account_role"("role");

-- CreateIndex
CREATE INDEX "audit_entry_created_at_idx" ON "audit_entry"("created_at");

-- CreateIndex
CREATE INDEX "audit_entry_actor_account_id_created_at_idx" ON "audit_entry"("actor_account_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entry_action_created_at_idx" ON "audit_entry"("action", "created_at");

-- AddForeignKey
ALTER TABLE "account_role" ADD CONSTRAINT "account_role_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
