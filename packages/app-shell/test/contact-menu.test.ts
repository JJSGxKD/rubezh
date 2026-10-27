import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import { MainMenu } from "../src/app/MainMenu";
import { t } from "../src/i18n";
import { SettingsScreen } from "../src/screens/settings";
import { useContact } from "../src/state/contact";
import { initShell } from "../src/state/shell";

// Пункт «Связаться с разработчиком» в меню и настройках (tasks/T-0344):
// ссылка есть — пункт стоит перед «Помощью в тестировании»; нет — пункта нет.

beforeEach(() => {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: undefined,
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useContact.setState({ url: null });
});

const menu = (): string => renderToStaticMarkup(createElement(MainMenu, { onClose: () => undefined }));
const settings = (): string => renderToStaticMarkup(createElement(SettingsScreen));

describe.each([
  ["меню", menu],
  ["настройки", settings],
])("%s", (_name, render) => {
  it("ссылка есть — пункт присутствует и стоит перед «Помощью в тестировании»", () => {
    useContact.setState({ url: "https://t.me/dev?direct" });
    const html = render();
    const contact = html.indexOf(t("menu.contact"));
    expect(contact).toBeGreaterThan(-1);
    expect(html.indexOf(t("settings.testers"), contact)).toBeGreaterThan(contact);
    expect(html.slice(0, contact)).not.toContain(t("settings.about"));
  });

  it("ссылки нет — пункта нет", () => {
    expect(render()).not.toContain(t("menu.contact"));
  });
});
