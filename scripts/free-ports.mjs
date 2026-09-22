#!/usr/bin/env node
/**
 * Освободить порты разработки: `pnpm stop` (или `pnpm stop 4001 5173`).
 *
 * Зачем это нужно. На Windows Ctrl+C убивает процесс, который держит консоль,
 * но не всегда его потомков: бэкенд под наблюдателем файлов остаётся жить
 * сиротой и держит порт до перезагрузки. Следующий `pnpm dev` падает с
 * `EADDRINUSE`, и человек ищет PID руками.
 *
 * Скрипт трогает только процессы, слушающие названные порты, и печатает, кого
 * именно убивает — чтобы случайно не снести чужое.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Порты из карты в docs/20-env-and-ports.md §2, плюс staging-смещение API. */
export const DEFAULT_PORTS = [4000, 4001, 5173, 5174, 5175, 5176, 5177];

function readPortsFromArgs() {
  const ports = process.argv
    .slice(2)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0);
  return ports.length > 0 ? ports : DEFAULT_PORTS;
}

function freePorts(targets) {
  let freed = 0;
  for (const port of targets) {
    for (const pid of listenersOn(port)) {
      const name = processName(pid);
      try {
        kill(pid);
        console.log(`порт ${port}: остановлен ${name} (PID ${pid})`);
        freed++;
      } catch (error) {
        console.error(`порт ${port}: не удалось остановить PID ${pid} — ${error.message}`);
      }
    }
  }

  console.log(
    freed === 0 ? "Все порты свободны, останавливать нечего." : `Освобождено портов: ${freed}`,
  );
}

/** PID процессов, слушающих порт. Пусто, если порт свободен. */
function listenersOn(port) {
  return process.platform === "win32" ? windowsListeners(port) : unixListeners(port);
}

/**
 * Аргументы netstat. Без фильтра по протоколу: `-p tcp` на Windows
 * показывает **только IPv4**, а IPv6-слушатели живут под `-p tcpv6` — и порт,
 * занятый процессом на `[::1]`, скрипт не находил вовсе, отвечая «все порты
 * свободны». Именно так слушает dev-сервер Vite, ради которого скрипт и
 * написан. UDP-строки отсеивает сам разбор: у них нет колонки состояния.
 */
export const NETSTAT_ARGS = ["-ano"];

function windowsListeners(port) {
  return parseWindowsListeners(run("netstat", NETSTAT_ARGS), port);
}

/**
 * Разбор вывода netstat. Вынесен отдельно ради тестов: ошибка здесь означает
 * убитый чужой процесс, а не просто незакрытый порт.
 */
export function parseWindowsListeners(output, port) {
  const pids = new Set();

  for (const line of output.split(/\r?\n/)) {
    // Формат: Proto | Local Address | Foreign Address | State | PID
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;

    // Адрес бывает 0.0.0.0:4000, 127.0.0.1:4000 и [::1]:4000 — сравнивается
    // только хвост после последнего двоеточия и строго целиком: иначе запрос
    // порта 4001 задел бы процесс на 40010.
    if (parts[1].slice(parts[1].lastIndexOf(":") + 1) !== String(port)) continue;

    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }

  return [...pids];
}

function unixListeners(port) {
  const output = run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  return output
    .split(/\r?\n/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processName(pid) {
  if (process.platform !== "win32") return run("ps", ["-p", String(pid), "-o", "comm="]).trim() || "процесс";
  const output = run("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
  const match = /^"([^"]+)"/.exec(output.trim());
  return match === null ? "процесс" : match[1];
}

function kill(pid) {
  if (process.platform === "win32") {
    // /T — вместе с деревом потомков: именно они и остаются висеть.
    execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
    return;
  }
  process.kill(pid, "SIGKILL");
}

/** Команды диагностики могут возвращать ненулевой код — это не ошибка. */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return typeof error.stdout === "string" ? error.stdout : "";
  }
}

// Запуск только при прямом вызове: разбор вывода netstat покрыт тестами, и
// импорт модуля не должен никого убивать. Блок стоит в конце файла, а не в
// начале: сверху он выполнялся раньше объявлений const ниже и падал на них
// временной мёртвой зоной — как в scripts/release/*.mjs, где он всегда внизу.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) freePorts(readPortsFromArgs());
