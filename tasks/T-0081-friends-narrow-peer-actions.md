---
id: T-0081
title: Друзья — на узком экране кнопки заявки и «Подарить» значками, имя читается
epic: E12
priority: P2
status: ready
owner:
author: claude-lead2-6
size: S
depends_on: [T-0076]
zones:
  - packages/app-shell/src/screens/meta/friends-parts.tsx
  - packages/app-shell/src/screens/meta/friends.tsx
  - packages/app-shell/src/screens/meta/friends-rules.ts
  - packages/app-shell/test/friends-rules.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
version: v0.8
---

# T-0081. Друзья — на узком экране кнопки заявки и «Подарить» значками, имя читается

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0081.json)](README.md#значки-статуса) [![T-0076](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0076.json&label=T-0076)](T-0076-friends-no-invite-flash.md)

## Зачем

В заявке в друзья две текстовые кнопки («Принять», «Отклонить») на узком
телефоне вытесняют имя целиком и сжимают аватар: игрок не видит, кто зовёт.
Рядом с «Подарить» длинное имя друга тоже обрезается («Гри…» на 320 px).
Находка приёмки PR #268 (T-0048), 12.10. После задачи на экране уже 430 px эти
кнопки — значки с подписью для экранного диктора, имя занимает освободившееся
место, аватар не сжимается.

## Решения

Решение тимлида от 13.10.2026, исполнитель его не пересматривает:

- **Меньше 430 px** кнопки «Принять», «Отклонить» (входящие заявки) и
  «Подарить» / «Подарено» (список друзей) — значками, текст скрыт. Подпись для
  диктора — `aria-label` теми же словами, что и текст кнопки.
- **От 430 px** — как сейчас, текстом.
- **Значки — из набора оболочки** (`lucide-react`, как везде): `Check`
  (принять; «Подарено»), `X` (отклонить), `Gift` (подарить). Новых иконок и
  картинок нет.
- **Порог — существующим в оболочке способом:** произвольные варианты Tailwind
  по ширине окна в пикселях (`min-[430px]:` — как `min-[360px]:` в
  `screens/home-widgets.tsx:291`). Новых медиазапросов, хуков ширины и
  `@custom-variant` не заводим.
- **«Отменить»** в исходящих заявках — остаётся текстом: кнопка одна, имени
  хватает места.
- Какой значок и какая подпись у действия — **чистая функция** в
  `friends-rules.ts` (DOM-тестов у оболочки нет).

## Как сейчас

- `packages/app-shell/src/screens/meta/friends-parts.tsx:294-315` — `PeerRow`:
  `<Card>` со строкой `flex items-center gap-3`: слева кнопка-«имя» (`flex
  min-w-0 flex-1 items-center gap-3`: `Avatar` 36 px и усечённое имя), справа
  `<div className="flex shrink-0 items-center gap-2">{props.children}</div>` —
  кнопки не сжимаются, поэтому всё давление берут имя и аватар.
- `packages/app-shell/src/screens/meta/friends.tsx`:
  - блок `incoming` (искать `friends.accept`): две `Button` — `variant="secondary"`
    «Принять» (`api.accept`) и `variant="ghost"` «Отклонить» (`api.decline`),
    у обеих `loading={busy === …}`;
  - блок `outgoing` (`friends.cancel`) — не трогаем;
  - список друзей (искать `friends.gift.sent`): `Button variant="secondary"` с
    `disabled={gifted || giftsClosed}`, `loading={busy === \`gift:…\`}`, внутри
    значок `Check`/`Gift` (16 px, `aria-hidden`) и текст `friends.gift.sent` /
    `friends.gift`.
- Ключи (есть в `i18n/ru-friends.json`): `friends.accept` «Принять»,
  `friends.decline` «Отклонить», `friends.gift` «Подарить», `friends.gift.sent`
  «Подарено». Новых нет.
- `Button` (`design-system/components/Button.tsx`) принимает `ariaLabel`,
  `loading`, `disabled`, `variant`; размер `m` — `min-h-12 px-5`, у значка без
  текста получается около 58 px по ширине. Свой класс кнопке не передать, и
  размер `s` (36 px) слишком мал для нажатия пальцем — остаётся `m`.
- T-0076 (`depends_on`) правит в `friends.tsx` пояснение над экраном, расчёт
  `layout` и строку с `Invite`; блоки заявок и списка он не затрагивает, но
  файл общий — поэтому работаем после него.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): новое описание в
   `test/friends-rules.test.ts`. Падают, пока функции нет.
2. **`friends-rules.ts`:** добавить

   ```ts
   export type PeerActionKind = "accept" | "decline" | "gift" | "gifted";
   export interface PeerActionView {
     /** Ключ подписи: текст на широком экране и `aria-label` на узком. */
     labelKey: string;
     icon: "check" | "x" | "gift";
     /** Значок виден и рядом с текстом (подарки); у заявок он только вместо текста. */
     iconWithText: boolean;
   }
   export function peerActionView(kind: PeerActionKind): PeerActionView;
   ```

   Таблица: `accept` → `friends.accept`, `check`, `false`; `decline` →
   `friends.decline`, `x`, `false`; `gift` → `friends.gift`, `gift`, `true`;
   `gifted` → `friends.gift.sent`, `check`, `true`.
3. **`friends-parts.tsx`:**
   - над `PeerRow` — две константы с классами (одно место порога; полные
     строки, чтобы Tailwind их увидел):

     ```ts
     // Ширина окна, с которой кнопки в строке игрока снова подписаны текстом (решение 13.10.2026).
     const TEXT_FROM_430 = "max-[429px]:hidden";
     const ICON_ONLY_BELOW_430 = "min-[430px]:hidden";
     ```

   - новый компонент:

     ```tsx
     export function PeerAction(props: { kind: PeerActionKind; variant: "secondary" | "ghost"; loading?: boolean; disabled?: boolean; onClick: () => void }): ReactNode {
       const view = peerActionView(props.kind);
       const label = t(view.labelKey);
       const Icon = view.icon === "check" ? Check : view.icon === "x" ? X : Gift;
       return (
         <Button variant={props.variant} loading={props.loading === true} disabled={props.disabled === true} ariaLabel={label} onClick={props.onClick}>
           <Icon size={16} aria-hidden="true" className={view.iconWithText ? "" : ICON_ONLY_BELOW_430} />
           <span className={TEXT_FROM_430}>{label}</span>
         </Button>
       );
     }
     ```

     В импорт `lucide-react` дописать `X` (`Check`, `Gift` там уже есть).
   - в `PeerRow` обернуть `<Avatar … />` в `<span className="shrink-0">…</span>`:
     аватар не должен сжиматься, когда не хватает места.
4. **`friends.tsx`:** заменить кнопки на `PeerAction` (в импорте из
   `./friends-parts` добавить `PeerAction`):
   - «Принять»: `<PeerAction kind="accept" variant="secondary" loading={busy === \`accept:${request.accountId}\`} onClick={() => void act(…)} />`;
   - «Отклонить»: `kind="decline" variant="ghost"`, то же для `loading` и `onClick`;
   - «Подарить»: `kind={gifted ? "gifted" : "gift"} variant="secondary"
     disabled={gifted || giftsClosed}` и прежние `loading`/`onClick`.
   Обработчики `act(…)` и условия не менять — только вид. Импорты `Check` и
   `Gift` из `lucide-react` убрать из `friends.tsx`, если там они больше не
   используются.
5. **`docs/27-design-system-and-app-shell.md`:** в строке `**Друзья** | Друзья |
   рабочий` в конец описания (после фразы, которую добавил T-0076) дописать:
   «На экране уже 430 px кнопки заявок и «Подарить» — значки с подписью для
   диктора, от 430 px — текстом.»
6. **Глазами:** в браузере на ширинах 320, 360, 429, 430 и 768 px — заявка:
   имя читается (на 320 — не одна буква), аватар круглый; на 430 и шире кнопки
   с текстом, как до правки; «Подарить» — значок `Gift`, после подарка `Check`.
   Нет возможности запустить — написать об этом в PR.

## Чего не трогаем

- Исходящие заявки и их кнопку «Отменить».
- `Button`, `IconButton`, `tokens.css`: ни нового размера, ни нового медиазапроса.
- Проп `badge` у `PeerRow` и знак «Тестер» — T-0043 (v0.10), он ляжет сверху.
- Текст имени (усечение `truncate` остаётся: очень длинное имя всё равно
  обрежется, но не до буквы).
- Расчёт порядка экрана и приглашение — T-0076.

## Сценарий и интерфейс

Игрок открывает «Друзья»:

- **Узкий телефон (меньше 430 px).** Входящая заявка: аватар, имя, справа два
  значка — галочка («Принять») и крестик («Отклонить»). Друг: имя и значок
  подарка; после подарка — галочка, кнопка неактивна.
- **От 430 px.** Как раньше: «Принять», «Отклонить», «Подарить» /
  «Подарено» текстом (у подарка со значком).
- **Загрузка действия** — спиннер на нажатой кнопке (оба вида).
- **Ограничение аккаунта / подарки закрыты** — «Подарить» неактивна (оба вида).
- **Диктор** читает «Принять», «Отклонить», «Подарить», «Подарено» в обоих
  видах.
- Пусто, ошибка, нет сети — без изменений (T-0076).

## Тесты

Первым коммитом. `packages/app-shell/test/friends-rules.test.ts`: новое
`describe("кнопки в строке игрока")`, импорт `peerActionView` из
`../src/screens/meta/friends-rules` и словаря
`import ru from "../src/i18n/ru-friends.json"` (в тесте
`const dictionary = new Map<string, string>(Object.entries(ru))`).

- `peerActionView("accept")` → `labelKey: "friends.accept"`, `icon: "check"`,
  `iconWithText: false`;
- `peerActionView("decline")` → `friends.decline`, `"x"`, `false`;
- `peerActionView("gift")` → `friends.gift`, `"gift"`, `true`;
- `peerActionView("gifted")` → `friends.gift.sent`, `"check"`, `true`;
- подписи теми же словами: `dictionary.get(labelKey)` для `accept`, `decline`,
  `gift`, `gifted` равно «Принять», «Отклонить», «Подарить», «Подарено» —
  значок без слова не должен остаться без подписи;
- все четыре `labelKey` различны (две разные кнопки не получат одну подпись).

## Аналитика

Нет — вид кнопок; события друзей не затрагиваются.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — строка «Друзья» (шаг 5).

## Вопросы к тимлиду

- Решено `claude-lead-1` 13.10.2026: порог **430 px**, а не 390. По замеру приёмки на 390 px при
  текстовых кнопках имя уже сжималось до «Д.», а 390 — ширина iPhone 12–14; 430 закрывает и самые
  широкие телефоны.
- Подтверждено `claude-lead-1` 13.10.2026: «Отменить» в исходящих остаётся текстом.

## Критерии приёмки

- [ ] `peerActionView` в `friends-rules.ts`, тесты из раздела «Тесты» зелёные,
  первым коммитом падали.
- [ ] Меньше 430 px у «Принять», «Отклонить», «Подарить»/«Подарено» виден значок,
  текст скрыт, `aria-label` совпадает с текстом; от 430 px — текст, как раньше.
- [ ] Порог задан только классами `min-[430px]:` / `max-[429px]:` в двух
  константах; новых медиазапросов, хуков и вариантов в `tokens.css` нет.
- [ ] Аватар в `PeerRow` не сжимается; на 320 px имя в заявке читается дальше
  первой буквы.
- [ ] Дифф только в зонах задачи и в одной строке `docs/27`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Показать имя в заявке в друзья на узком экране`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено: в заявке в друзья на узком экране видно, кто зовёт: кнопки «Принять», «Отклонить» и «Подарить» стали значками`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДРУЗЬЯ: ИМЯ В ЗАЯВКЕ НА УЗКОМ ЭКРАНЕ**

  На экранах уже 430 px кнопки заявки и «Подарить» стали значками с подписью для диктора, имя друга больше не обрезается до буквы.

  🛠 **Экран друзей**

  • какой значок и подпись у действия — чистая функция с тестами
  • аватар в строке игрока не сжимается
  ```
