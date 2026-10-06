import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { TEST_NOTICE_REPOSITORY, type TestNoticeAcceptance, type TestNoticeRepository } from "./test-notice.repository.js";

/**
 * Предупреждение об открытом тесте (docs/35-stage4-plan.md Р59, WP33):
 * данные могут не сохраниться, а вайп компенсируем бонусом. Текст и его
 * версия — у клиента: он показывает предупреждение, пока принятая версия
 * старше той, что он несёт. Сервер помнит принятие на аккаунт, а не на
 * устройство: сменил телефон — второй раз не спросят.
 */

const DB_TIMEOUT_MS = 3_000;

export interface TestNoticeView {
  /** `null` — игрок предупреждение ещё не принимал */
  acceptedVersion: number | null;
}

@Injectable()
export class TestNoticeService {
  private readonly logger = new Logger("test-notice");

  constructor(@Inject(TEST_NOTICE_REPOSITORY) private readonly repository: TestNoticeRepository) {}

  async view(accountId: string): Promise<TestNoticeView> {
    const acceptance = await withTimeout(this.repository.find(accountId), DB_TIMEOUT_MS, "предупреждение о тесте");
    return { acceptedVersion: acceptance?.version ?? null };
  }

  async accept(accountId: string, version: number, at = new Date()): Promise<TestNoticeView> {
    const acceptance = await withTimeout(this.repository.accept(accountId, version, at), DB_TIMEOUT_MS, "предупреждение о тесте");
    if (acceptance.acceptedAt.getTime() === at.getTime()) this.logger.log(JSON.stringify({ module: "test-notice", event: "test_notice_accepted", accountId, version }));
    return { acceptedVersion: acceptance.version };
  }

  /** Принятие для карточки игрока и проверки «видел до первой покупки». */
  async acceptance(accountId: string): Promise<TestNoticeAcceptance | null> {
    return await withTimeout(this.repository.find(accountId), DB_TIMEOUT_MS, "предупреждение о тесте");
  }
}
