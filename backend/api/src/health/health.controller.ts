import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/access.js";

@Controller("health")
export class HealthController {
  // Пробы и мониторинг не авторизуются: недоступный health — это и есть
  // недоступный сервис.
  @Public()
  @Get()
  check() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }
}
