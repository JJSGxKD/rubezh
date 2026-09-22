import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devServerConfig } from "../vite/dev-server";

/**
 * Настройки dev-сервера трёх площадок (scripts/vite/dev-server.ts).
 *
 * Главное, что здесь закрепляется: **пустое окружение не меняет ничего**.
 * Сервер, начавший слушать сеть или требовать сертификат просто потому, что
 * кто-то тронул общий модуль, отдал бы dev-сборку всей локальной сети — и
 * заметили бы это не сразу.
 */

const REPO_ROOT = join(tmpdir(), "rubezh-dev-server-test");

function config(env: Record<string, string>, repoRoot = REPO_ROOT) {
  return devServerConfig({ env, repoRoot, port: 5173, tunnelHostVar: "DEV_TUNNEL_TELEGRAM_HOST" });
}

/** Пара файлов, изображающих сертификат: содержимое неважно, важен путь. */
function certificateFiles(): { dir: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "rubezh-cert-"));
  writeFileSync(join(dir, "cert.pem"), "сертификат");
  writeFileSync(join(dir, "key.pem"), "ключ");
  return { dir, cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
}

describe("настройки dev-сервера", () => {
  it("без переменных слушает только петлю и не просит сертификат", () => {
    const { server, preview } = config({});

    expect(server).toEqual({ port: 5173, strictPort: true });
    expect(preview).toEqual({ port: 5173, strictPort: true });
  });

  it("с туннелем пускает его домен и уводит туда HMR", () => {
    const { server, preview } = config({ DEV_TUNNEL_TELEGRAM_HOST: "rubezh-tg.frps.gonet.fun" });

    expect(server.allowedHosts).toEqual(["rubezh-tg.frps.gonet.fun"]);
    expect(server.hmr).toEqual({ protocol: "wss", host: "rubezh-tg.frps.gonet.fun", clientPort: 443 });
    // Наружу туннель выводит frpc — сам сервер сеть не слушает.
    expect(server.host).toBeUndefined();
    // На просмотре собранной версии HMR нет вовсе.
    expect(preview).not.toHaveProperty("hmr");
  });

  it("чужую переменную туннеля не читает: у каждой площадки своя", () => {
    expect(config({ DEV_TUNNEL_VK_HOST: "rubezh-vk.frps.gonet.fun" }).server.allowedHosts).toBeUndefined();
  });

  it("с адресом локальной сети слушает сеть и пускает этот адрес", () => {
    const { server } = config({ DEV_LAN_HOST: "dev.gonet.fun" });

    expect(server.host).toBe(true);
    expect(server.allowedHosts).toEqual(["dev.gonet.fun"]);
    // Домен и порт те же, что у страницы: клиент Vite соберёт адрес сам.
    expect(server.hmr).toBeUndefined();
  });

  it("туннель и локальная сеть уживаются: пускаются оба адреса", () => {
    const { server } = config({ DEV_TUNNEL_TELEGRAM_HOST: "tunnel.example", DEV_LAN_HOST: "lan.example" });

    expect(server.allowedHosts).toEqual(["tunnel.example", "lan.example"]);
  });

  it("читает сертификат и отдаёт его и серверу, и просмотру сборки", () => {
    const { cert, key } = certificateFiles();

    const { server, preview } = config({ DEV_HTTPS_CERT: cert, DEV_HTTPS_KEY: key });

    expect(String(server.https?.cert)).toBe("сертификат");
    expect(String(server.https?.key)).toBe("ключ");
    expect(String(preview.https?.cert)).toBe("сертификат");
  });

  it("с сертификатом слушает IPv4-петлю: localhost на Windows это ::1", () => {
    const { cert, key } = certificateFiles();

    // Умолчание Vite подняло бы сервер только на ::1, и адрес из BotFather —
    // https://127.0.0.1 — не ответил бы (проверено вживую).
    expect(config({ DEV_HTTPS_CERT: cert, DEV_HTTPS_KEY: key }).server.host).toBe("127.0.0.1");
  });

  it("адрес локальной сети сильнее: там нужны все интерфейсы", () => {
    const { cert, key } = certificateFiles();

    expect(config({ DEV_HTTPS_CERT: cert, DEV_HTTPS_KEY: key, DEV_LAN_HOST: "dev.gonet.fun" }).server.host).toBe(true);
  });

  it("ищет относительный путь от корня монорепо", () => {
    const { dir, key } = certificateFiles();

    const { server } = config({ DEV_HTTPS_CERT: "cert.pem", DEV_HTTPS_KEY: key }, dir);

    expect(String(server.https?.cert)).toBe("сертификат");
  });

  it("половину пары не принимает — это опечатка, а не «как раньше»", () => {
    const { cert } = certificateFiles();

    expect(() => config({ DEV_HTTPS_CERT: cert })).toThrow(/DEV_HTTPS_CERT и DEV_HTTPS_KEY/);
    expect(() => config({ DEV_HTTPS_KEY: cert })).toThrow(/DEV_HTTPS_CERT и DEV_HTTPS_KEY/);
  });

  it("на нечитаемом файле называет переменную и полный путь", () => {
    const { cert } = certificateFiles();

    expect(() => config({ DEV_HTTPS_CERT: cert, DEV_HTTPS_KEY: "нет-такого.pem" })).toThrow(
      /DEV_HTTPS_KEY.*нет-такого\.pem/s,
    );
  });
});
