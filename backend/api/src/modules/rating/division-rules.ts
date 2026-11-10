import { Prisma } from "../../generated/prisma/client.js";

/**
 * Дивизионы сезона по доле доски (tasks/T-0295, Р152, `design/art/meta-v2.md`
 * §2.3): рубин — первый процент доски, золото — первые 10 %, серебро — первые
 * 35 %, бронза — все остальные с рейтинговым забегом сезона. Доли — постоянные
 * этого файла: их меняет решение владельца, а не панель.
 *
 * Чистые правила без Nest, базы и часов. Границы считаются **целыми
 * процентами**: `0,35 × 20` в двойной точности даёт `7,000000000000001`, и
 * потолок поднял бы границу серебра с седьмого места на восьмое.
 */

/** От высшего к низшему; порядок — порядок проверки. */
export const DIVISIONS = ["ruby", "gold", "silver", "bronze"] as const;
export type Division = (typeof DIVISIONS)[number];

/** Верхние доли доски, в процентах от числа игроков. У бронзы доли нет — она всё остальное. */
export const DIVISION_PERCENT: Readonly<Record<Exclude<Division, "bronze">, number>> = { ruby: 1, gold: 10, silver: 35 };

/** Сколько мест доски входит в дивизион: доля округляется вверх, поэтому на любой доске рубин — хотя бы первое место. */
function placesOf(percent: number, boardSize: number): number {
  return Math.ceil((boardSize * percent) / 100);
}

/**
 * Дивизион по месту и размеру доски; `null` — забега нет (`rank` пуст) или
 * место не лежит на доске (нуль, дробь, больше размера, пустая доска).
 */
export function divisionOf(rank: number | null, boardSize: number): Division | null {
  if (rank === null || !Number.isInteger(rank) || !Number.isInteger(boardSize) || boardSize < 1 || rank < 1 || rank > boardSize) return null;
  if (rank <= placesOf(DIVISION_PERCENT.ruby, boardSize)) return "ruby";
  if (rank <= placesOf(DIVISION_PERCENT.gold, boardSize)) return "gold";
  if (rank <= placesOf(DIVISION_PERCENT.silver, boardSize)) return "silver";
  return "bronze";
}

/**
 * Тот же выбор дивизиона на стороне SQL — для закрытия сезона, где места и
 * размеры доски уже лежат в `season_result.place` и `season_result.board_size`.
 * Доли идут параметрами из `DIVISION_PERCENT`, а не числами в тексте запроса:
 * правило остаётся в одном месте.
 */
export function divisionCaseSql(): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN place <= ceil(board_size * ${DIVISION_PERCENT.ruby}::numeric / 100) THEN 'ruby'
    WHEN place <= ceil(board_size * ${DIVISION_PERCENT.gold}::numeric / 100) THEN 'gold'
    WHEN place <= ceil(board_size * ${DIVISION_PERCENT.silver}::numeric / 100) THEN 'silver'
    ELSE 'bronze'
  END`;
}
