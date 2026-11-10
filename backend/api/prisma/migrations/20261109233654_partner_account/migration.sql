-- Роль «партнёр» и связь карточки партнёра с игровым аккаунтом (tasks/T-0217, docs/35-stage4-plan.md Р136).
-- Только расширения: ничего не удаляется, код прошлого релиза на такой схеме работает.
--
-- Role.partner    — внешний человек: пускает в панель, но только в его кабинет. Выдаётся из карточки партнёра.
-- partner.account_id — аккаунт, чей кабинет открыт карточке. Уникален: один аккаунт — один партнёр. Остаётся и после
--                  закрытия кабинета — по нему игрок не привязывается к самому себе. Аккаунт удалён — связь пуста,
--                  карточка и приведённые игроки остаются.

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'partner';

-- AlterTable
ALTER TABLE "partner" ADD COLUMN     "account_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "partner_account_id_key" ON "partner"("account_id");

-- AddForeignKey
ALTER TABLE "partner" ADD CONSTRAINT "partner_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE SET NULL ON UPDATE CASCADE;
