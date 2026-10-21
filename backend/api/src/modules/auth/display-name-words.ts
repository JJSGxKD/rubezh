/**
 * Словарь мата и оскорблений для чистки ников (tasks/T-0149, T-0153).
 *
 * Словарь в публичном репозитории — осознанно: корни не секрет, а ловится
 * ими только то, что игрок и так видит в рейтинге и «Друзьях». Точность
 * важнее полноты: у ников есть ручная смена в панели. Новое ложное
 * срабатывание — не повод ослаблять корень, а строка в `ALLOWED` (подстрока)
 * или `ALLOWED_WORDS` (слово целиком) с тестом в `display-name.test.ts`.
 *
 * Текст сворачивается четырьмя способами, и корень ищется в каждом: латиница
 * вместо кириллицы («cyka» → «сука»), транслит («huj» → «хуй»), транслит с
 * `y` и `x` («huy», «xyu» → «хуй») и латиница с цифрами вместо букв для
 * английских корней («f4ck»). Во всех буквы строчные, `ё` → `е`, повтор одной
 * буквы схлопнут («хуууй» → «хуй»). Корень в начале слова ищется и после одной
 * приставки («уебан», «заебал»), но «Колебание» и «Скипидар» — не мат.
 */

/** Ищется в нике целиком, без пробелов и разделителей. */
const ANYWHERE = ["хуй", "хуя", "хую", "пизд", "ебал", "ебло", "ебуч", "мудак", "мудил", "пидор", "гандон", "залуп", "шлюх"];

/** Ищется только в начале слова: иначе «Корабля» и «Сукачёв» — мат. */
const WORD_START = ["хуе", "ебат", "ебан", "пидар", "бля", "сука", "суки", "сучк", "сучар", "ебу", "еби", "fuck", "shit", "bitch", "cunt", "dick", "nigg", "faggot"];

/** Из начала слова — эти корни ещё и после приставки: «уебан», «заебал». «Усуки» — не мат: корню «суки» приставка не положена. */
const WORD_START_PREFIXED = ["хуе", "еби", "ебу", "ебан", "ебат", "пидар"];
const PREFIXES = ["за", "у", "на", "вы", "по", "от", "до", "раз", "при", "об"];

/**
 * Слова, которые целиком совпадают с корнем, но не мат: Hue, Huey, Dick, Ebi,
 * Suka, Suki. Подстрока здесь не годится — она вырезала бы корень и из
 * «huesos», «dickhead». Сравнение буквальное, только латиницей: кириллическое
 * «Сука» и «хуе» под исключение не попадают.
 */
const ALLOWED_WORDS = new Set(["hue", "huey", "dick", "ebi", "suka", "suki"]);

/**
 * Подстроки, которые вырезаются из свёртки до поиска корней. «nigg» после
 * схлопывания повторов — «nig», поэтому английские имена на «nige» вынесены
 * сюда же.
 */
const ALLOWED = ["страхуй", "психуй", "сукно", "сукровиц", "сукач", "dickens", "nigel", "nigeri", "night", "nigmat", "nigin", "сучков", "dickson", "shitij", "ebubekir", "shitov", "shitake", "nahuel"];

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

/** Как `TRANSLIT`, плюс `x` → «х»: «xuy», «xyu». */
const TRANSLIT_X: Record<string, string> = { ...TRANSLIT, x: "х" };

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

/**
 * `y` в конце слова — «й», `yu` в конце — «уй», в середине `y` остаётся «ы»:
 * иначе «Huyen» стало бы «хуен». Конец строки — конец слова, поэтому свёртка
 * применяется и к склеенному нику, и к каждому слову.
 */
function foldTranslitY(text: string): string {
  let result = base(text).replace(/yu$/u, "уй").replace(/y$/u, "й");
  for (const [latin, cyrillic] of TRANSLIT_PAIRS) result = result.replaceAll(latin, cyrillic);
  return collapse(mapChars(result, TRANSLIT_X));
}

function foldLatin(text: string): string {
  return collapse(mapChars(base(text), LATIN));
}

const FOLDS = [foldSimilar, foldTranslit, foldTranslitY, foldLatin];

const ANYWHERE_ROOTS = ANYWHERE.map((root) => collapse(root));
const WORD_START_ROOTS = WORD_START.map((root) => collapse(root));
const PREFIXED_ROOTS = WORD_START_PREFIXED.map((root) => collapse(root));

/** Исключения сворачиваются той же свёрткой, что и текст: иначе в смешанной записи («nigеl») они не найдутся. */
function foldWithoutAllowed(fold: (text: string) => string, text: string): string {
  let result = fold(text);
  for (const word of ALLOWED) result = result.replaceAll(fold(word), "");
  return result;
}

/** Корень в начале слова или после одной приставки (с необязательным «ъ»). */
function startsWithRoot(text: string): boolean {
  if (WORD_START_ROOTS.some((root) => text.startsWith(root))) return true;
  return PREFIXES.some((prefix) => {
    if (!text.startsWith(prefix)) return false;
    const rest = text.slice(prefix.length).replace(/^ъ/u, "");
    return PREFIXED_ROOTS.some((root) => rest.startsWith(root));
  });
}

function isAllowedWord(word: string): boolean {
  return /^[a-z]+$/u.test(base(word)) && ALLOWED_WORDS.has(base(word));
}

/** Есть ли в нике мат или оскорбление. Ник приходит уже очищенным от лишних знаков. */
export function hasProfanity(name: string): boolean {
  const words = name.split(SEPARATORS).filter((word) => word !== "" && !isAllowedWord(word));
  const joined = words.join("");
  for (const fold of FOLDS) {
    const folded = foldWithoutAllowed(fold, joined);
    if (ANYWHERE_ROOTS.some((root) => folded.includes(root))) return true;
    // Начало всего ника — для «с.у.к.а», где слов нет, а корень разбит разделителями.
    if (startsWithRoot(folded)) return true;
    // Каждое слово отдельно: конец склейки — не конец слова («huy Вася»).
    for (const word of words) {
      const foldedWord = foldWithoutAllowed(fold, word);
      if (ANYWHERE_ROOTS.some((root) => foldedWord.includes(root)) || startsWithRoot(foldedWord)) return true;
    }
  }
  return false;
}
