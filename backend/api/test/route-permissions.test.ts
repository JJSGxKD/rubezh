import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { Type } from "@nestjs/common";
import { AppModule } from "../src/app.module.js";
import { PERMISSION_METADATA, PUBLIC_METADATA } from "../src/modules/roles/permission.guard.js";
import { PERMISSIONS } from "../src/modules/roles/permissions.js";

/**
 * Закрыто по умолчанию (docs/15-engineering-standards.md §7,
 * docs/29-admin-panel.md §3.4).
 *
 * Каждый маршрут обязан объявить либо гвард, либо явную публичность. Забытая
 * проверка тихо открывает эндпоинт, и по коду этого не видно: в диффе новый
 * метод контроллера выглядит ровно так же, как закрытый.
 *
 * Граф модулей читается из метаданных Nest, а не перечисляется руками:
 * список в тесте разошёлся бы с приложением ровно тогда, когда кто-то добавит
 * контроллер и забудет про тест.
 */

const PATH_METADATA = "path";
const GUARDS_METADATA = "__guards__";

interface RouteInfo {
  controller: string;
  method: string;
  handler: (...args: unknown[]) => unknown;
  guarded: boolean;
}

function controllersOf(module: Type<unknown>, seen = new Set<Type<unknown>>()): Type<unknown>[] {
  if (seen.has(module)) return [];
  seen.add(module);

  const controllers = (Reflect.getMetadata("controllers", module) as Type<unknown>[] | undefined) ?? [];
  const imports = (Reflect.getMetadata("imports", module) as Type<unknown>[] | undefined) ?? [];
  return [...controllers, ...imports.flatMap((imported) => controllersOf(imported, seen))];
}

function routesOf(controller: Type<unknown>): RouteInfo[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) !== undefined;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .filter((name) => Reflect.hasMetadata(PATH_METADATA, prototype[name] as object))
    .map((name) => {
      const handler = prototype[name] as (...args: unknown[]) => unknown;
      return {
        controller: controller.name,
        method: name,
        handler,
        guarded: classGuards || Reflect.getMetadata(GUARDS_METADATA, handler) !== undefined,
      };
    });
}

const routes = controllersOf(AppModule).flatMap(routesOf);

describe("права на маршрутах", () => {
  it("маршруты вообще находятся: иначе тест зелёный и бесполезный", () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it("каждый маршрут объявил гвард или явную публичность", () => {
    const undeclared = routes
      .filter((route) => !route.guarded && Reflect.getMetadata(PUBLIC_METADATA, route.handler) !== true)
      .map((route) => `${route.controller}.${route.method}`);

    expect(undeclared, "добавьте гвард или @Public() с объяснением почему").toEqual([]);
  });

  it("требуемое право — из перечня, а не строкой на глаз", () => {
    const unknown = routes
      .map((route) => ({ route, permission: Reflect.getMetadata(PERMISSION_METADATA, route.handler) as unknown }))
      .filter((entry) => entry.permission !== undefined)
      .filter((entry) => !(PERMISSIONS as readonly unknown[]).includes(entry.permission))
      .map((entry) => `${entry.route.controller}.${entry.route.method}: ${String(entry.permission)}`);

    expect(unknown).toEqual([]);
  });

  it("маршрут с правом стоит под гвардом: иначе проверять права не у кого", () => {
    const unguarded = routes
      .filter((route) => Reflect.getMetadata(PERMISSION_METADATA, route.handler) !== undefined)
      .filter((route) => !route.guarded)
      .map((route) => `${route.controller}.${route.method}`);

    expect(unguarded).toEqual([]);
  });

  it("публичный маршрут не притворяется защищённым правом", () => {
    const both = routes
      .filter((route) => Reflect.getMetadata(PUBLIC_METADATA, route.handler) === true)
      .filter((route) => Reflect.getMetadata(PERMISSION_METADATA, route.handler) !== undefined)
      .map((route) => `${route.controller}.${route.method}`);

    expect(both).toEqual([]);
  });
});
