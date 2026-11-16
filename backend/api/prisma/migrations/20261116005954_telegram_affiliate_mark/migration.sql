-- Метка партнёрки Telegram (docs/35-stage4-plan.md Р97, tasks/T-0072): игрок пришёл по ссылке
-- программы бота (`_tgr_<id>`). Одна строка на аккаунт, навсегда; занимает слот источника наравне
-- с `referral_binding` и `partner_binding`. Только новая таблица, существующее не трогается.

-- CreateTable
CREATE TABLE "telegram_affiliate_mark" (
    "account_id" UUID NOT NULL,
    "start_param" VARCHAR(64) NOT NULL,
    "ref" VARCHAR(64) NOT NULL,
    "marked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_affiliate_mark_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "telegram_affiliate_mark" ADD CONSTRAINT "telegram_affiliate_mark_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;
