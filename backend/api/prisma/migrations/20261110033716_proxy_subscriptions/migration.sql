-- AlterTable
ALTER TABLE "proxy_subscription" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Несколько подписок (Р192): ключ — строчные латиница и цифры, как его выдаёт API.
-- Исходная подписка сохраняет ключ `main`: от него зависят шифртекст адреса и x-hwid.
ALTER TABLE "proxy_subscription" DROP CONSTRAINT "proxy_subscription_key_check";
ALTER TABLE "proxy_subscription"
  ADD CONSTRAINT "proxy_subscription_key_check" CHECK ("key" ~ '^[a-z0-9]{1,16}$');
