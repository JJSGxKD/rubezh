import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { openExternalLink } from "./external-link";
import { useSession } from "./session";
import { track } from "./shell";
import { createShopApi, invoiceSchema, type ShopApi, type ShopInvoice } from "./shop-api";

/**
 * Донаты проекту (docs/35-stage4-plan.md, Р109, T-0158): что показать на листе
 * доната — одним запросом — и счёт на сумму. Что доступно игроку (звёзды,
 * ссылка Tribute своей площадки), решает сервер: клиент не проверяет площадку,
 * стоп-кран оплаты и закрытые покупки сам и рисует то, что пришло.
 *
 * Донат — поддержка, а не покупка: игровых ценностей нет. Окно оплаты,
 * ожидание подтверждения и события `purchase_*` — готовая `buy()` магазина
 * (`shop-purchase.ts`), счёт тот же `ShopInvoice`.
 *
 * Модуль грузится вместе с блоком доната — первой загрузке он не нужен.
 */

const modeSchema = z.enum(["live", "test"]);

const viewSchema = z.object({
  /** звёздная часть; `null` — оплата выключена, площадка без способа, платить нечем или покупки закрыты */
  stars: z.nullable(
    z.object({
      min: z.number(),
      max: z.number(),
      presets: z.array(z.number()),
      mode: modeSchema,
    }),
  ),
  /** ссылка Tribute для площадки игрока и её разрез в аналитике; нет поля или `null` — кнопки нет */
  tribute: z.optional(z.nullable(z.object({ url: z.string(), way: z.string() }))),
  /** аккаунт уже поддержал проект */
  supporter: z.boolean(),
});

export type DonationView = z.infer<typeof viewSchema>;
export type DonationStars = NonNullable<DonationView["stars"]>;

export interface DonationsApi {
  view(): Promise<ApiResult<DonationView>>;
  order(amount: number): Promise<ApiResult<ShopInvoice>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createDonationsApi(request: ApiRequest = apiRequest): DonationsApi {
  return {
    view: () => request("/api/v1/donations", viewSchema, { method: "GET" }),
    order: (amount) => request("/api/v1/donations/orders", invoiceSchema, { method: "POST", body: { amount } }),
  };
}

/** Опрос состояния покупки — тот же, что у магазина: донат — обычная покупка для платёжного слоя. */
export function purchasePoller(): Pick<ShopApi, "purchase"> {
  return createShopApi();
}

/**
 * Успешный донат: знак «Меценат» встаёт в сессию сразу, не дожидаясь
 * следующего входа. Без сессии ставить некуда — игрок так и не вошёл.
 */
export function markSupporter(): void {
  const { account } = useSession.getState();
  if (account === null || account.supporter === true) return;
  useSession.setState({ account: { ...account, supporter: true } });
}

/** Где игрок нажал: «Об игре», профиль или слайд главной — разрез события `donation_link_clicked`. */
export type DonatePlace = "about" | "profile" | "home";

/**
 * Открыть ссылку Tribute и записать клик — в том же нажатии: площадка
 * открывает ссылки только в ответ на касание. Оплата по ссылке идёт вне игры
 * и знака не даёт, поэтому клик — всё, что видно.
 */
export function openTribute(tribute: { url: string; way: string }, place: DonatePlace): void {
  openExternalLink(tribute.url);
  track("donation_link_clicked", { way: tribute.way, place });
}
