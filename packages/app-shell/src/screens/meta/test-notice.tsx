import { useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, ContentColumn, IconEmblem, Screen } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/test-notice";
import { useNavigation } from "../../state/navigation";
import { acceptTestNotice } from "../../state/test-notice";
import { TestNoticeText } from "./test-notice-text";

/**
 * Предупреждение об открытом тесте для тех, кто прошёл первый запуск до него
 * (docs/35-stage4-plan.md Р59, WP33). Новичок видит то же на экране первого
 * запуска. «Назад» не принимает предупреждение — оно покажется при следующем
 * входе, до первой покупки.
 */
export function TestNoticeScreen(): ReactNode {
  const navigation = useNavigation();
  const [pending, setPending] = useState(false);

  const accept = async (): Promise<void> => {
    setPending(true);
    // Сеть могла пропасть: принятие уже запомнено на устройстве и дойдёт до
    // сервера со следующим входом — держать игрока на экране незачем.
    await acceptTestNotice();
    navigation.pop();
  };

  return (
    <Screen
      title={t("testNotice.title")}
      onBack={() => navigation.pop()}
      footer={
        <Button size="l" block glow loading={pending} onClick={() => void accept()}>
          {t("testNotice.accept")}
        </Button>
      }
    >
      <ContentColumn>
        <div className="mt-4 mb-4 flex justify-center">
          <IconEmblem size="l" tone="info">
            <ShieldCheck size={36} />
          </IconEmblem>
        </div>
        <TestNoticeText />
      </ContentColumn>
    </Screen>
  );
}
