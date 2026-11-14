-- Выданные облики (docs/35-stage4-plan.md Р155, tasks/T-0245). Облик, выданный разово —
-- куплен в «Наборе хранителя», позже подарен или получен в пассе, — состоянием аккаунта не
-- вычислить, поэтому хранится строкой. Остальные облики сервер по-прежнему считает при
-- чтении (tasks/T-0237).

-- CreateTable
CREATE TABLE "appearance_grant" (
    "account_id" UUID NOT NULL,
    "appearance_id" VARCHAR(24) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "purchase_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appearance_grant_pkey" PRIMARY KEY ("account_id","appearance_id")
);

-- CreateIndex
CREATE INDEX "appearance_grant_purchase_id_idx" ON "appearance_grant"("purchase_id");

-- AddForeignKey
ALTER TABLE "appearance_grant" ADD CONSTRAINT "appearance_grant_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appearance_grant" ADD CONSTRAINT "appearance_grant_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("purchase_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Облик, купленный за звёзды, всегда ссылается на покупку: возврат снимает его ровно по ней,
-- и без ссылки снимать было бы нечего. Ошибка в коде упрётся в базу, а не в игрока.
ALTER TABLE "appearance_grant" ADD CONSTRAINT "appearance_grant_purchase_check" CHECK ("source" <> 'purchase' OR "purchase_id" IS NOT NULL);
