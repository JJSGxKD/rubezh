-- CreateEnum
CREATE TYPE "FriendSource" AS ENUM ('link', 'request');

-- AlterEnum
ALTER TYPE "StartKind" ADD VALUE 'friend';

-- CreateTable
CREATE TABLE "friend_link" (
    "code" VARCHAR(32) NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_link_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "friendship" (
    "account_a" UUID NOT NULL,
    "account_b" UUID NOT NULL,
    "source" "FriendSource" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendship_pkey" PRIMARY KEY ("account_a","account_b")
);

-- CreateTable
CREATE TABLE "friend_request" (
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_request_pkey" PRIMARY KEY ("from_account_id","to_account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "friend_link_account_id_key" ON "friend_link"("account_id");

-- CreateIndex
CREATE INDEX "friendship_account_b_idx" ON "friendship"("account_b");

-- CreateIndex
CREATE INDEX "friend_request_to_account_id_created_at_idx" ON "friend_request"("to_account_id", "created_at");

-- AddForeignKey
ALTER TABLE "friend_link" ADD CONSTRAINT "friend_link_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_account_a_fkey" FOREIGN KEY ("account_a") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_account_b_fkey" FOREIGN KEY ("account_b") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_request" ADD CONSTRAINT "friend_request_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_request" ADD CONSTRAINT "friend_request_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Инварианты, которых Prisma не описывает: пара дружбы хранится меньшим
-- идентификатором первым — иначе одна дружба могла бы лечь двумя строками;
-- заявка самому себе бессмысленна.
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_ordered_pair" CHECK ("account_a" < "account_b");
ALTER TABLE "friend_request" ADD CONSTRAINT "friend_request_not_self" CHECK ("from_account_id" <> "to_account_id");
