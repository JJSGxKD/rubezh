import type { ReactNode } from "react";
import { Gift, Swords, Trophy, UserRound, Users } from "lucide-react";
import {
  Avatar,
  Card,
  ContentColumn,
  PageTitle,
  Screen,
  SectionTitle,
  StubScreen,
} from "../design-system/components";
import { t } from "../i18n";
import { useNavigation } from "../state/navigation";
import { useShell } from "../state/shell";

/**
 * Разделы-заглушки. Каждый открывается, выглядит как будущий раздел и явно
 * помечен «в разработке»: молча ничего не делающая кнопка — баг, а не
 * заглушка (docs/27-design-system-and-app-shell.md §6).
 *
 * Каждый заход пишется `screen_viewed` с признаком заглушки: к этапам 4–5 у
 * нас будут данные о том, какой раздел тестеры открывали чаще, а не мнения.
 */
export function ArsenalScreen(): ReactNode {
  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("arsenal.title")}</PageTitle>
        <StubScreen
          icon={<Swords size={40} />}
          title={t("arsenal.characters")}
          text={t("arsenal.characters.soon")}
        />
        <SectionTitle>{t("arsenal.weapons")}</SectionTitle>
        <Card>
          <p className="text-xs text-text-muted">{t("arsenal.weapons.soon")}</p>
        </Card>
        <SectionTitle>{t("arsenal.upgrades")}</SectionTitle>
        <Card>
          <p className="text-xs text-text-muted">{t("arsenal.upgrades.soon")}</p>
        </Card>
      </ContentColumn>
    </Screen>
  );
}

export function ShopScreen(): ReactNode {
  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("shop.title")}</PageTitle>
        <StubScreen icon={<Gift size={40} />} title={t("shop.title")} text={t("shop.soon")} />
      </ContentColumn>
    </Screen>
  );
}

export function RatingScreen(): ReactNode {
  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("rating.title")}</PageTitle>
        <StubScreen icon={<Trophy size={40} />} title={t("rating.title")} text={t("rating.soon")} />
        <SectionTitle>{t("rating.example")}</SectionTitle>
        <div className="grid gap-2">
          {[1, 2, 3].map((place) => (
            <Card key={place}>
              <div className="flex items-center gap-3">
                <span className="w-5 font-display text-text-muted tabular-nums">{place}</span>
                <Avatar name="?" />
                <span className="flex-1 text-sm text-text-disabled">—</span>
                <span className="text-sm text-text-disabled tabular-nums">—</span>
              </div>
            </Card>
          ))}
        </div>
      </ContentColumn>
    </Screen>
  );
}

export function FriendsScreen(): ReactNode {
  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("friends.title")}</PageTitle>
        <StubScreen icon={<Users size={40} />} title={t("friends.title")} text={t("friends.soon")} />
      </ContentColumn>
    </Screen>
  );
}

/**
 * Профиль. Имя и аватар — из параметров запуска площадки и только для
 * отображения: это не проверенная личность (docs/08-web-and-identity.md §4).
 */
export function ProfileScreen(): ReactNode {
  const navigation = useNavigation();
  const user = useShell((state) => state.adapter.displayUser);

  return (
    <Screen title={t("profile.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <Card>
          <div className="flex items-center gap-3">
            <Avatar name={user?.displayName ?? t("profile.guest")} url={user?.avatarUrl} size={48} />
            <span className="font-display text-base text-text">
              {user?.displayName ?? t("profile.guest")}
            </span>
          </div>
        </Card>
        <StubScreen
          icon={<UserRound size={40} />}
          title={t("profile.title")}
          text={t("profile.soon")}
        />
      </ContentColumn>
    </Screen>
  );
}
