/**
 * Словарь мата и оскорблений для чистки ников (tasks/T-0149).
 *
 * Словарь в публичном репозитории — осознанно: корни не секрет, а ловится
 * ими только то, что игрок и так видит в рейтинге и «Друзьях». Новое ложное
 * срабатывание — не повод ослаблять корень, а строка в `ALLOWED_WORDS` с
 * тестом в `display-name.test.ts`.
 *
 * Текст сворачивается тремя способами, и корень ищется в каждом: латиница
 * вместо кириллицы («cyka» → «сука»), транслит («huj» → «хуй») и латиница
 * с цифрами вместо букв для английских корней («f4ck»). Во всех трёх буквы
 * строчные, `ё` → `е`, повтор одной буквы схлопнут («хуууй» → «хуй»).
 */

/** Ищется в нике целиком, без пробелов и разделителей. */
const ANYWHERE = ["хуй", "хуе", "хуя", "хую", "пизд", "ебат", "ебан", "ебал", "ебло", "ебуч", "мудак", "мудил", "пидор", "пидар", "гандон", "залуп", "шлюх"];

/** Ищется только в начале слова: иначе «Корабля» и «Сукачёв» — мат. */
const WORD_START = ["бля", "сука", "суки", "сучк", "сучар", "ебу", "еби", "fuck", "shit", "bitch", "cunt", "dick", "nigg", "faggot"];

/**
 * Подстроки, которые вырезаются из свёртки до поиска корней. «nigg» после
 * схлопывания повторов — «nig», поэтому английские имена на «nige» вынесены
 * сюда же.
 */
const ALLOWED = ["страхуй", "психуй", "сукно", "сукровиц", "сукач", "dickens", "nigel", "nigeri"];

/** Символы, которыми прячут корень: «х.у.й», «х_у_й». */
export const SEPARATORS = /[\s.\-_*]+/u;

const SIMILAR: Record<string, string> = {
  a: "а", b: "б", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", "0": "о", "3": "з", "6": "б", "@": "а",
};

const TRANSLIT_PAIRS: [string, string][] = [["sh", "ш"], ["ch", "ч"], ["zh", "ж"], ["ya", "я"], ["yu", "ю"]];

const TRANSLIT: Record<string, string> = {
  a: "а", b: "б", c: "ц", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "й", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", r: "р", s: "с", t: "т", u: "у", v: "в", y: "ы", z: "з",
  "0": "о", "1": "и", "3": "з", "4": "ч", "6": "б", "@": "а",
};

const LATIN: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "@": "a" };

function mapChars(text: string, table: Record<string, string>): string {
  let result = "";
  for (const char of text) result += table[char] ?? char;
  return result;
}

/** Повтор одной буквы подряд — одна буква. */
function collapse(text: string): string {
  return text.replace(/(.)\1+/gu, "$1");
}

function base(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е");
}

function foldSimilar(text: string): string {
  return collapse(mapChars(base(text), SIMILAR));
}

function foldTranslit(text: string): string {
  let result = base(text);
  for (const [latin, cyrillic] of TRANSLIT_PAIRS) result = result.replaceAll(latin, cyrillic);
  return collapse(mapChars(result, TRANSLIT));
}

function foldLatin(text: string): string {
  return collapse(mapChars(base(text), LATIN));
}

const FOLDS = [foldSimilar, foldTranslit, foldLatin];

const ANYWHERE_ROOTS = ANYWHERE.map((root) => collapse(root));
const WORD_START_ROOTS = WORD_START.map((root) => collapse(root));

/** Исключения сворачиваются той же свёрткой, что и текст: иначе в смешанной записи («nigеl») они не найдутся. */
function foldWithoutAllowed(fold: (text: string) => string, text: string): string {
  let result = fold(text);
  for (const word of ALLOWED) result = result.replaceAll(fold(word), "");
  return result;
}

/** Есть ли в нике мат или оскорбление. Ник приходит уже очищенным от лишних знаков. */
export function hasProfanity(name: string): boolean {
  const words = name.split(SEPARATORS).filter((word) => word !== "");
  const joined = words.join("");
  for (const fold of FOLDS) {
    const folded = foldWithoutAllowed(fold, joined);
    if (ANYWHERE_ROOTS.some((root) => folded.includes(root))) return true;
    // Начало всего ника — для «с.у.к.а», где слов нет, а корень разбит разделителями.
    if (WORD_START_ROOTS.some((root) => folded.startsWith(root))) return true;
    for (const word of words) {
      const foldedWord = foldWithoutAllowed(fold, word);
      if (WORD_START_ROOTS.some((root) => foldedWord.startsWith(root))) return true;
    }
  }
  return false;
}
