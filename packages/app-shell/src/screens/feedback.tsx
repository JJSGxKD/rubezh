import { useState, type ReactNode } from "react";
import { MessageSquareHeart, Send } from "lucide-react";
import { FEEDBACK_TEXT_MAX, type FeedbackAnswers, type FeedbackQuestionId } from "@bh/shared-types";
import { Button, Card, ContentColumn, Screen, SectionTitle } from "../design-system/components";
import { t } from "../i18n";
import { feedbackQuestions, useFeedback } from "../state/feedback";
import { useNavigation } from "../state/navigation";
import { uiFeedback } from "../state/ui-feedback";

/**
 * Форма обратной связи (docs/29-admin-panel.md §6): три быстрых вопроса и
 * поле для пожеланий.
 *
 * Вопросы — кнопками, а не полями ввода: на телефоне в игре набирают текст
 * единицы, а нажать три раза готов почти каждый. Свободное поле остаётся для
 * тех, кому есть что сказать, и именно оно ценнее всего.
 */
export function FeedbackScreen(): ReactNode {
  const navigation = useNavigation();
  const sending = useFeedback((state) => state.sending);
  const [answers, setAnswers] = useState<FeedbackAnswers>({});
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const empty = Object.keys(answers).length === 0 && text.trim() === "";

  const send = async (): Promise<void> => {
    setFailure(null);
    const result = await useFeedback.getState().send(answers, text);
    if (result === null) {
      setSent(true);
      return;
    }
    setFailure(t(`feedback.error.${result}`));
  };

  if (sent) {
    return (
      <Screen title={t("feedback.title")} onBack={() => navigation.pop()}>
        <ContentColumn>
          <Card>
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <MessageSquareHeart size={28} aria-hidden="true" className="text-accent" />
              <h2 className="font-display text-lg font-bold text-text">{t("feedback.thanks.title")}</h2>
              <p className="max-w-[320px] text-sm text-text-muted">{t("feedback.thanks.text")}</p>
              <Button onClick={() => navigation.pop()}>{t("feedback.thanks.back")}</Button>
            </div>
          </Card>
        </ContentColumn>
      </Screen>
    );
  }

  return (
    <Screen
      title={t("feedback.title")}
      onBack={() => navigation.pop()}
      footer={
        <Button
          size="l"
          block
          glow
          disabled={empty || sending}
          onClick={() => {
            uiFeedback("primary");
            void send();
          }}
        >
          <Send size={18} />
          {sending ? t("feedback.sending") : t("feedback.send")}
        </Button>
      }
    >
      <ContentColumn>
        <p className="mt-2 text-sm text-text-muted">{t("feedback.intro")}</p>

        {feedbackQuestions().map((question) => (
          <div key={question.id}>
            <SectionTitle>{t(`feedback.q.${question.id}`)}</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {question.options.map((option) => {
                const active = answers[question.id as FeedbackQuestionId] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    className={[
                      "rounded-pill border px-3 py-1.5 font-display text-sm font-semibold transition-colors",
                      active
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-line bg-surface text-text-muted",
                    ].join(" ")}
                    onClick={() => {
                      uiFeedback("select");
                      // Повторное нажатие снимает ответ: игрок вправе
                      // передумать и не отвечать на вопрос вовсе.
                      setAnswers((current) => {
                        const next = { ...current };
                        if (active) delete next[question.id as FeedbackQuestionId];
                        else next[question.id as FeedbackQuestionId] = option;
                        return next;
                      });
                    }}
                  >
                    {t(`feedback.q.${question.id}.${option}`)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <SectionTitle>{t("feedback.text.title")}</SectionTitle>
        <textarea
          value={text}
          maxLength={FEEDBACK_TEXT_MAX}
          rows={5}
          placeholder={t("feedback.text.placeholder")}
          aria-label={t("feedback.text.title")}
          className="surface-sunken w-full rounded-md px-3 py-2 text-sm text-text placeholder:text-text-disabled"
          onChange={(event) => setText(event.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          {t("feedback.text.left", { left: FEEDBACK_TEXT_MAX - text.length })}
        </p>

        {failure === null ? null : <p className="mt-3 text-sm text-danger">{failure}</p>}
      </ContentColumn>
    </Screen>
  );
}
