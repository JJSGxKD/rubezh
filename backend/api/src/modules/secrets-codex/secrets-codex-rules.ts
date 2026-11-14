import type { RecordedRun } from "../runs/runs-hooks.js";

/**
 * Кодекс тайников (docs/35-stage4-plan.md Р153, design/art/meta-v2.md §5.3,
 * tasks/T-0261): правила без Nest и базы. Вид открывается, когда игрок нашёл
 * тайник в забеге, и не закрывается обратно; награда — одно достижение
 * «Следопыт» каталога заданий, а не отдельная система.
 */

/**
 * Виды тайников движка. Бэкенд `shared-types` не импортирует, поэтому список —
 * копия `SECRET_KINDS`, а равенство держит тест: новый вид в движке роняет его,
 * пока вид не добавили сюда. Порядок — канонический, в нём же отвечает ручка.
 */
export const SECRETS_CODEX_KINDS = ["shrine", "hoard", "stone", "tree", "rift", "wisp"] as const;

export type SecretKind = (typeof SECRETS_CODEX_KINDS)[number];

/** Достижение за все виды: его строку клиент не показывает, оно живёт в общей витрине. */
export const SECRETS_CODEX_REWARD_TASK_ID = "ach_secrets_all";

/** Вид — из списка движка. Итог забега и строки базы приходят извне, поэтому проверка нужна. */
export function isSecretKind(value: string): value is SecretKind {
  return (SECRETS_CODEX_KINDS as readonly string[]).includes(value);
}

/**
 * Какие виды забег открывает впервые: найденные в нём виды из списка, которых
 * ещё нет у игрока, без повторов и в каноническом порядке. Чужие значения
 * отбрасываются.
 */
export function newKinds(run: Pick<RecordedRun, "secretsFound">, known: ReadonlySet<string>): SecretKind[] {
  const found = new Set(run.secretsFound ?? []);
  return SECRETS_CODEX_KINDS.filter((kind) => found.has(kind) && !known.has(kind));
}

/**
 * Сколько видов найдено: считаются только виды списка. Запись про вид, которого
 * в движке больше нет, в прогресс «Следопыта» не идёт.
 */
export function secretsKindsAmount(known: ReadonlySet<string>): number {
  return SECRETS_CODEX_KINDS.filter((kind) => known.has(kind)).length;
}
