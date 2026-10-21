import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
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
 */
@Module({
  imports: [AuthModule],
  providers: [
    SessionRecorder,
    { provide: SESSIONS_REPOSITORY, useClass: PrismaSessionsRepository },
    { provide: SESSION_DEDUPE, useClass: RedisSessionDedupe },
  ],
  // Касания аккаунта — карточке игрока в панели.
  exports: [SESSIONS_REPOSITORY],
})
export class AttributionModule {}
