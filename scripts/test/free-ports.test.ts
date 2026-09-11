import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { parseWindowsListeners, DEFAULT_PORTS } from "../free-ports.mjs";

// Скрипт убивает процессы, поэтому цена ошибки разбора — снесённый чужой
// процесс, а не просто незакрытый порт. Отсюда и тесты.

const NETSTAT_OUTPUT = [
  "",
  "Активные подключения",
  "",
  "  Имя    Локальный адрес        Внешний адрес          Состояние       PID",
  "  TCP    0.0.0.0:4001           0.0.0.0:0              LISTENING       31664",
  "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       2048",
  "  TCP    0.0.0.0:40010          0.0.0.0:0              LISTENING       9999",
  "  TCP    [::]:4001              [::]:0                 LISTENING       31664",
  "  TCP    127.0.0.1:4001         127.0.0.1:54321        ESTABLISHED     777",
  "  UDP    0.0.0.0:4001           *:*                                    555",
].join("\r\n");

describe("разбор вывода netstat", () => {
  it("находит процесс, слушающий порт", () => {
    expect(parseWindowsListeners(NETSTAT_OUTPUT, 5173)).toEqual([2048]);
  });

  it("не путает порт с тем, у которого он в начале", () => {
    // 40010 начинается с 4001 — наивное сравнение по вхождению убило бы
    // посторонний процесс.
    expect(parseWindowsListeners(NETSTAT_OUTPUT, 4001)).not.toContain(9999);
  });

  it("не повторяет PID, если процесс слушает и IPv4, и IPv6", () => {
    expect(parseWindowsListeners(NETSTAT_OUTPUT, 4001)).toEqual([31664]);
  });

  it("игнорирует установленные соединения и UDP — там слушателя нет", () => {
    const pids = parseWindowsListeners(NETSTAT_OUTPUT, 4001);
    expect(pids).not.toContain(777);
    expect(pids).not.toContain(555);
  });

  it("возвращает пусто, когда порт свободен", () => {
    expect(parseWindowsListeners(NETSTAT_OUTPUT, 9090)).toEqual([]);
  });

  it("переживает пустой вывод", () => {
    expect(parseWindowsListeners("", 4001)).toEqual([]);
  });

  it("знает порты из карты портов", () => {
    expect(DEFAULT_PORTS).toContain(4000);
    expect(DEFAULT_PORTS).toContain(5173);
  });
});
