-- CreateTable
CREATE TABLE "showcase_offer" (
    "offer_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "game_day" DATE NOT NULL,
    "position" SMALLINT NOT NULL,
    "slot" "ItemSlot" NOT NULL,
    "rarity" "ItemRarity" NOT NULL,
    "level" INTEGER NOT NULL,
    "seed" BIGINT NOT NULL,
    "rolls" JSONB NOT NULL,
    "price_gems" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "sold_at" TIMESTAMPTZ(3),
    "item_id" UUID,

    CONSTRAINT "showcase_offer_pkey" PRIMARY KEY ("offer_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "showcase_offer_account_id_game_day_position_key" ON "showcase_offer"("account_id", "game_day", "position");

-- AddForeignKey
ALTER TABLE "showcase_offer" ADD CONSTRAINT "showcase_offer_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Продано — значит, есть купленный предмет, и наоборот; цена и уровень —
-- в пределах, которые понимает остальной код.
ALTER TABLE "showcase_offer" ADD CONSTRAINT "showcase_offer_sold_check" CHECK (("sold_at" IS NULL) = ("item_id" IS NULL));
ALTER TABLE "showcase_offer" ADD CONSTRAINT "showcase_offer_price_check" CHECK ("price_gems" > 0);
ALTER TABLE "showcase_offer" ADD CONSTRAINT "showcase_offer_level_check" CHECK ("level" BETWEEN 1 AND 30);
ALTER TABLE "showcase_offer" ADD CONSTRAINT "showcase_offer_position_check" CHECK ("position" >= 0);
