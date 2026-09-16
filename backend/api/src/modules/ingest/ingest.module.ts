import { Global, Module } from "@nestjs/common";
import { IngestGuard } from "./ingest.guard.js";
import { RateLimiter } from "./rate-limiter.js";

/** Общая защита приёмников событий и отчётов (docs/28-diagnostics.md §5.3). */
@Global()
@Module({
  providers: [RateLimiter, IngestGuard],
  exports: [RateLimiter, IngestGuard],
})
export class IngestModule {}
