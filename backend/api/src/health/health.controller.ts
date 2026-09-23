import { Controller, Get } from "@nestjs/common";
import { Public } from "../modules/roles/permission.guard.js";

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
