import type { ReactNode } from "react";
import { Store } from "lucide-react";
import { ContentColumn, PageTitle, Screen, StubScreen } from "../design-system/components";
import { t } from "../i18n";

/**
 * Разделы-заглушки. Каждый открывается, выглядит как будущий раздел и явно
 * помечен «в разработке»: молча ничего не делающая кнопка — баг, а не
 * заглушка (docs/27-design-system-and-app-shell.md §6).
 *
 * Каждый заход пишется `screen_viewed` с признаком заглушки: к этапам 4–5 у
 * нас будут данные о том, какой раздел тестеры открывали чаще, а не мнения.
 */
export function ShopScreen(): ReactNode {
  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("shop.title")}</PageTitle>
        <StubScreen icon={<Store size={40} />} title={t("shop.title")} text={t("shop.soon")} />
      </ContentColumn>
    </Screen>
  );
}
