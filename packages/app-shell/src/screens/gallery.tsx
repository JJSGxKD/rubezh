import type { ReactNode } from "react";
import { Gem, Star } from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  ContentColumn,
  CurrencyChip,
  ListGroup,
  ListItem,
  ProgressBar,
  Screen,
  SectionTitle,
  Stat,
} from "../design-system/components";
import { t } from "../i18n";
import { useNavigation } from "../state/navigation";

/**
 * Витрина компонентов — экран внутри приложения, доступный в режиме
 * диагностики (docs/27-design-system-and-app-shell.md §9).
 *
 * Вместо Storybook, и для нашей задачи это лучше него: компоненты видны в
 * настоящем WebView Telegram на настоящем устройстве, с настоящими отступами
 * безопасной зоны, а не в десктопном браузере.
 */
export function GalleryScreen(): ReactNode {
  const navigation = useNavigation();

  return (
    <Screen title={t("gallery.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <SectionTitle>{t("gallery.buttons")}</SectionTitle>
        <div className="grid gap-2">
          <Button>primary</Button>
          <Button variant="secondary">secondary</Button>
          <Button variant="ghost">ghost</Button>
          <Button variant="danger">danger</Button>
          <Button loading>loading</Button>
          <Button disabled>disabled</Button>
          <Button size="l" block>
            large block
          </Button>
        </div>

        <SectionTitle>{t("gallery.cards")}</SectionTitle>
        <div className="grid gap-2">
          <Card>
            <span className="font-display text-base text-text">Обычная карточка</span>
            <p className="mt-1 text-xs text-text-muted">
              Самый длинный текст, который встретится: русские заголовки длиннее английских
              примерно в полтора раза, и проверять вёрстку надо на них.
            </p>
          </Card>
          <Card selected onClick={() => undefined}>
            Выбранная
          </Card>
          <Card disabled>Недоступная</Card>
        </div>

        <SectionTitle>{t("gallery.lists")}</SectionTitle>
        <ListGroup>
          <ListItem title="Со значением" value="42" />
          <ListItem title="С подписью" hint="Пояснение под заголовком" />
          <ListItem title="С переходом" onClick={() => undefined} />
          <ListItem title="С переключателем" toggle={{ checked: true, onChange: () => undefined }} />
          <ListItem
            title="Выключенный переключатель"
            hint="И подпись, объясняющая почему"
            toggle={{ checked: false, disabled: true, onChange: () => undefined }}
          />
        </ListGroup>

        <SectionTitle>{t("gallery.progress")}</SectionTitle>
        <div className="grid gap-3">
          <ProgressBar value={7} max={10} tone="hp" label="HP" />
          <ProgressBar value={2} max={10} tone="hp-low" label="HP" />
          <ProgressBar value={4} max={10} tone="xp" height="thin" label="XP" />
        </div>

        <SectionTitle>{t("gallery.stats")}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Время выживания" value="7:42" large />
          <Stat label="Убито" value="1 284" />
        </div>

        <SectionTitle>{t("gallery.badges")}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>обычный</Badge>
          <Badge tone="accent">акцент</Badge>
          <Badge tone="warning">скоро</Badge>
          <CurrencyChip icon={<Gem size={14} />} value="1 200" />
          <Avatar name="Иван Петров" />
          <Star size={18} className="text-elite" />
        </div>
      </ContentColumn>
    </Screen>
  );
}
