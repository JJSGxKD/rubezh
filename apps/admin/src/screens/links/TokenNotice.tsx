import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { hrefOf } from "../../routes";
import { Notice } from "../../ui/kit";

/**
 * Токен нашего кабинета AdsGram не задан. Конверсии при этом не теряются —
 * копятся и уходят, когда токен зададут, — но человек, заводящий ссылку,
 * должен узнать об этом сейчас, а не по пустому кабинету через неделю.
 * Маркетологу ключи интеграций не видны: ему — к кому идти, а не ссылка в
 * раздел, который его не пустит.
 */
export function TokenNotice() {
  const view = useSession((session) => session.view);
  return (
    <Notice tone="warning">
      Токен конверсий AdsGram не задан — регистрации и покупки копятся и уйдут в сеть, как только его зададут. Токен берут в кабинете AdsGram, он один на все ссылки.{" "}
      {can(view, "secrets.edit") ? (
        <a className="font-semibold underline" href={hrefOf({ section: "secrets", id: null })}>
          Задать в «Ключах интеграций»
        </a>
      ) : (
        "Задать его может владелец в разделе «Ключи интеграций»."
      )}
    </Notice>
  );
}
