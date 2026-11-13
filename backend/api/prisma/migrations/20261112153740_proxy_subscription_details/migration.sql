-- AlterTable
ALTER TABLE "proxy_subscription" ADD COLUMN     "routing_block" INTEGER,
ADD COLUMN     "routing_direct" INTEGER,
ADD COLUMN     "routing_hints" VARCHAR(64)[],
ADD COLUMN     "routing_source" VARCHAR(12);

-- AlterTable
ALTER TABLE "proxy_subscription_node" ADD COLUMN     "flow" VARCHAR(32),
ADD COLUMN     "network" VARCHAR(12),
ADD COLUMN     "security" VARCHAR(8);

-- Транспорт и безопасность узла, маршрутизация подписки (Р192, T-0385): значения из
-- перечней proxy-kit; null — запись сделана до миграции и ещё не обновлялась.
ALTER TABLE "proxy_subscription_node"
  ADD CONSTRAINT "proxy_subscription_node_network_check" CHECK ("network" IS NULL OR "network" IN ('tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp')),
  ADD CONSTRAINT "proxy_subscription_node_security_check" CHECK ("security" IS NULL OR "security" IN ('none', 'tls', 'reality'));

ALTER TABLE "proxy_subscription"
  ADD CONSTRAINT "proxy_subscription_routing_source_check" CHECK ("routing_source" IS NULL OR "routing_source" IN ('none', 'json', 'header', 'json+header')),
  ADD CONSTRAINT "proxy_subscription_routing_direct_check" CHECK ("routing_direct" IS NULL OR "routing_direct" >= 0),
  ADD CONSTRAINT "proxy_subscription_routing_block_check" CHECK ("routing_block" IS NULL OR "routing_block" >= 0);
