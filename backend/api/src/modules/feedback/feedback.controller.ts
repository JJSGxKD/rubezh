import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { IngestEndpoint, IngestGuard, ingestIdentityOf } from "../ingest/ingest.guard.js";
import { FeedbackService } from "./feedback.service.js";

/**
 * Приём отзывов игроков (docs/29-admin-panel.md §6). Дверь та же, что у
 * событий и отчётов: подпись `initData` не обязательна, но проверенная
 * добавляет к отзыву Telegram ID — иначе на отзыв не ответить.
 */
@Controller("feedback")
@UseGuards(IngestGuard)
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Post()
  @HttpCode(200)
  @IngestEndpoint("feedback")
  async submit(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { feedbackId: string } }> {
    return { data: await this.service.receive(body, ingestIdentityOf(request)) };
  }
}
