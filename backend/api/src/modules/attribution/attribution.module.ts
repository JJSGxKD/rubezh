import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LinksModule } from "../links/links.module.js";
import { PartnersModule } from "../partners/partners.module.js";
import { RedisSessionDedupe, SESSION_DEDUPE } from "./session-dedupe.js";
import { SessionRecorder } from "./session-recorder.js";
import { PrismaSessionsRepository, SESSIONS_REPOSITORY } from "./sessions.repository.js";

/**
 * Сессии, первое и последнее касание (docs/34-stage3-plan.md, WP6;
 * перенос — docs/13-reuse-from-vpnsibcom.md §6). Модуль слушает вход и в него
 * не вмешивается: зависимость — от `AuthModule`, а не наоборот.
 *
 * Строка клика редирект-страницы (docs/24-attribution-and-sharing.md §3)
 * придёт вместе с ней; до тех пор код клика из параметра запуска
 * запоминается в сессии и касаниях как есть.
 *
 * Партнёры нужны записи сессии: по клику или прямой ссылке она привязывает
 * игрока к партнёру-владельцу ссылки (T-0067). `PartnersModule` не зависит
 * от атрибуции ни прямо, ни через другие модули — цикла нет. Параметр
 * привязки у `SessionRecorder` необязателен, поэтому забытый импорт молча
 * выключил бы её: подключение держит тест сборки приложения.
 *
 * Ссылки с метками заводят источник при записи сессии (Р116, T-0179):
 * рекордеру нужен `AutoSourcesService` из `LinksModule`, а тот модуль
 * атрибуции не импортирует — цикла нет. Параметр рекордера так же
 * необязателен, и подключение держит тот же тест.
 */
@Module({
  imports: [AuthModule, PartnersModule, LinksModule],
  providers: [
    SessionRecorder,
    { provide: SESSIONS_REPOSITORY, useClass: PrismaSessionsRepository },
    { provide: SESSION_DEDUPE, useClass: RedisSessionDedupe },
  ],
  // Касания аккаунта — карточке игрока в панели.
  exports: [SESSIONS_REPOSITORY],
})
export class AttributionModule {}
