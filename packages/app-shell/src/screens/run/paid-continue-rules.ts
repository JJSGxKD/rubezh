/**
 * Текст отказа оплаты второго шанса. Ограничение «Покупки» говорит словами
 * сервера — причину и срок знает он; временная недоступность — общим текстом
 * без подробностей (молчаливое ограничение выглядит как сбой).
 */
export function paidErrorText(code: string | null, message: string | null): { key: string } | { text: string } {
  if (code === "account_restricted" && message !== null && message.trim() !== "") return { text: message };
  if (code === "temporarily_unavailable") return { key: "run.continue.unavailable.not_offered" };
  return { key: "run.continue.retry.payment_failed" };
}
