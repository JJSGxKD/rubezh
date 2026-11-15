import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { RewardSettingKind } from "../src/modules/change-requests/reward-settings.js";
import { SettingsService } from "../src/modules/settings/settings.service.js";

describe("сборка вида правки «награда» в контейнере Nest", () => {
  it("контейнер находит настройки по классу, а не по стёртому типу", async () => {
    const settings = { get: () => 0, refresh: async () => undefined, reload: async () => undefined };
    @Module({ providers: [RewardSettingKind, { provide: SettingsService, useValue: settings }] })
    class Root {}
    // Без явного токена зависимость стёрлась бы в Object, и приложение падало бы при старте (process.abort).
    const context = await NestFactory.createApplicationContext(Root, { logger: false, abortOnError: false });
    try {
      expect(context.get(RewardSettingKind)).toBeInstanceOf(RewardSettingKind);
    } finally {
      await context.close();
    }
  });
});
