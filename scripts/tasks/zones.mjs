/**
 * Зоны задач: шаблоны путей, пересечения и выход за зоны (tasks/README.md,
 * «Поля задачи»). Чистые функции, тесты — scripts/test/tasks-zones.test.ts.
 */

const SPECIAL = /[.+^${}()|[\]\\]/;

/**
 * Шаблон пути → регулярное выражение на весь путь:
 * `*` — любые символы, кроме `/`; `**` — любые вложенные каталоги, а `**`
 * перед `/` совпадает и с нулём каталогов; `?` — один символ, кроме `/`; остальное
 * буквально. Каталог с `/` на конце — всё внутри него: так записаны, например,
 * миграции в `shared`.
 */
export function globToRegExp(pattern) {
  const source = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        out += "(?:.*/)?";
        index += 2;
      } else {
        out += ".*";
        index += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += SPECIAL.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matches(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function literalPaths(zones) {
  return zones.filter((zone) => !/[*?]/.test(zone) && !zone.endsWith("/"));
}

/**
 * Пересекаются ли зоны двух задач: есть путь, который лежит в обеих. Путей два
 * источника — файлы репозитория и буквальные зоны самих задач: без вторых два
 * новых файла с одним именем (их ещё нет в репозитории) не нашли бы друг друга.
 * Два шаблона без общего существующего файла пересечением не считаются.
 */
export function zonesOverlap(zonesA, zonesB, repoFiles) {
  const candidates = new Set([...repoFiles, ...literalPaths(zonesA), ...literalPaths(zonesB)]);
  for (const path of candidates) {
    if (matches(path, zonesA) && matches(path, zonesB)) return true;
  }
  return false;
}

/**
 * Изменённые файлы вне `zones`, `shared` и самого файла задачи (`task.fileName`
 * — имя в `tasks/`). Задача закрывается в своём PR на месте; в архив её и ссылки на
 * неё переносит уборка тимлида (`pnpm task archive`), поэтому `tasks/archive/` и
 * `tasks/epics.md` PR задачи не меняет (T-0343).
 */
export function outOfZone(changed, task) {
  const allowed = [...task.zones, ...task.shared, `tasks/${task.fileName}`];
  return changed.filter((path) => !matches(path, allowed));
}

/**
 * Подсказка к выходу за зоны внутри `tasks/`; `null`, если ни один путь из `outside`
 * не лежит в `tasks/`. Файл задачи в архиве возвращают наверх, затем `pnpm task fix`
 * возвращает ссылки в `epics.md` и чужих задачах к виду `dev`.
 */
export function outOfZoneHint(outside, fileName) {
  if (!outside.some((path) => path.startsWith("tasks/"))) return null;
  return `В PR задачи из tasks/ меняется только её файл, и он остаётся в tasks/: перенос в архив и ссылки на него — уборка тимлида (tasks/README.md, «Уборка архива»). Если файл задачи уже в архиве — верни его: git mv tasks/archive/${fileName} tasks/${fileName}, затем pnpm task fix — ссылки в tasks/epics.md и других задачах вернутся к виду dev.`;
}
