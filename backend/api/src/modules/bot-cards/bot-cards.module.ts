import { Module } from "@nestjs/common";
import { LIVE_CARD_ANSWERER } from "../../platforms/ports/live-card.js";
import { AccountSettingsModule } from "../account-settings/account-settings.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { BotMessagesModule } from "../bot-messages/bot-messages.module.js";
import { EventsModule } from "../events/events.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { NotificationsBotModule } from "../notifications-bot/notifications-bot.module.js";
import { BotCardEvents } from "./bot-card-events.js";
import { BotCardKinds } from "./bot-card-kinds.js";
import { BotCardsAnswerer } from "./bot-cards-answerer.js";
import { BotCardsFinalizer } from "./bot-cards.finalizer.js";
import { BOT_CARDS_REPOSITORY, PrismaBotCardsRepository } from "./bot-cards.repository.js";
import { BotCardsService } from "./bot-cards.service.js";
import { BotCardsUpdater } from "./bot-cards.updater.js";

/**
 * Живые карточки бота — ядро (docs/35-stage4-plan.md Р199, Р225, tasks/T-0395): учёт отправленных
 * карточек, «живая — одна на вид», запасное сообщение, прореженные правки, финал периода и ответы на
 * запросы. Виды («Сезон», «Награда дня», «Приглашения») регистрируют себя в `BotCardKinds` в своих
 * модулях и зовут `BotCardsService`; адаптер площадки (Telegram — T-0396) отдаёт порт `LiveCardPort` и
 * забирает ответчика `LIVE_CARD_ANSWERER`.
 *
 * Правки и отправки по триггерам идут очередью `notifications-bot` вместе с дублем уведомлений: темп
 * общий, поэтому `NotificationsBotModule` отдаёт свою очередь.
 */
@Module({
  imports: [AuthModule, MessagingModule, AccountSettingsModule, BotMessagesModule, NotificationsBotModule, EventsModule],
  providers: [
    BotCardKinds,
    { provide: BOT_CARDS_REPOSITORY, useClass: PrismaBotCardsRepository },
    BotCardsService,
    BotCardsUpdater,
    BotCardEvents,
    BotCardsAnswerer,
    { provide: LIVE_CARD_ANSWERER, useExisting: BotCardsAnswerer },
    BotCardsFinalizer,
  ],
  exports: [BotCardKinds, BotCardsService, LIVE_CARD_ANSWERER],
})
export class BotCardsModule {}
