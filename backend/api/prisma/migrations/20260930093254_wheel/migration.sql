-- CreateEnum
CREATE TYPE "WheelSpinSource" AS ENUM ('free', 'ad');

-- CreateTable
CREATE TABLE "wheel_spin" (
    "spin_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source" "WheelSpinSource" NOT NULL,
    "game_day" DATE NOT NULL,
    "sector" SMALLINT NOT NULL,
    "resource" "WalletResource" NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "granted_at" TIMESTAMPTZ(3),

    CONSTRAINT "wheel_spin_pkey" PRIMARY KEY ("spin_id")
);

-- CreateIndex
CREATE INDEX "wheel_spin_account_id_created_at_idx" ON "wheel_spin"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "wheel_spin" ADD CONSTRAINT "wheel_spin_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Бесплатная крутка — одна в игровые сутки. Частичный индекс: Prisma его не
-- описывает, поэтому он только здесь. Две крутки разом упрутся в него, а не
-- начислят сутки дважды; крутки за рекламу (WP12) его не касаются.
CREATE UNIQUE INDEX "wheel_spin_free_day_key" ON "wheel_spin"("account_id", "game_day") WHERE "source" = 'free';

-- Сектор — номер на экране, награда — не пустая: ноль монет на колесе — ошибка
-- в числах, а не выигрыш.
ALTER TABLE "wheel_spin" ADD CONSTRAINT "wheel_spin_sector_check" CHECK ("sector" >= 0);
ALTER TABLE "wheel_spin" ADD CONSTRAINT "wheel_spin_amount_check" CHECK ("amount" > 0);
