// Готовые сценарии снимков. Шаг — { click: "текст" } (нажать элемент с этим
// текстом), { clickIfShown: "текст" } (нажать, если появилось за 3 с) или
// { waitText: "текст" } (дождаться его на странице).
// Тексты — из packages/app-shell/src/i18n/ru.json: сменятся там, поправить и тут.

// Свежему пользователю снимков сначала показывают окно «Игра на тесте»
// (gate.firstRun.action): его закрывают в начале каждого сценария.
const DISMISS_FIRST_RUN = { clickIfShown: "Понятно, играем" };

export const SCENARIOS = [
  // Главная: ждём кнопку «Играть» (lobby.play), чтобы не снять заставку запуска.
  { id: "lobby", steps: [DISMISS_FIRST_RUN, { waitText: "Играть" }] },
  // Витрина компонентов открывается адресом, нужно право администратора
  // (--as owner, по умолчанию).
  { id: "gallery", screen: "gallery", steps: [DISMISS_FIRST_RUN] },
  // Лист «Перед забегом» (weapon.select.screen) открывается кнопкой «Играть».
  { id: "prerun", steps: [DISMISS_FIRST_RUN, { waitText: "Играть" }, { click: "Играть" }, { waitText: "Перед забегом" }] },
];
