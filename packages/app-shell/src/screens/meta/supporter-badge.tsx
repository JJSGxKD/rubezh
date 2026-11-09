import type { ReactNode } from "react";
import { Heart } from "lucide-react";
import { t } from "../../i18n";

/**
 * Знак «Меценат» (docs/35-stage4-plan.md Р109, Р149): поддержал проект. Сердце
 * тоном здоровья, **слово — цветом текста**: розовое слово на подложке даёт
 * 4,3:1 при норме 4,5:1. `size="l"` — в профиле и на «Спасибо!»; `iconOnly` — в
 * строке рейтинга: там имя, «Тестер» и «Ты» уже делят ширину, и слово на 320 px
 * съело бы имя, поэтому одно сердце с подписью для диктора и подсказкой.
 */
export function SupporterBadge(props: { size?: "s" | "l"; iconOnly?: boolean }): ReactNode {
  const large = props.size === "l";
  const word = t("supporter.badge");
  const frame = "inline-flex shrink-0 items-center rounded-sm bg-hp/15 ring-1 ring-hp/40";

  if (props.iconOnly === true) {
    return (
      <span role="img" aria-label={word} title={word} className={`${frame} p-0.5 text-hp`}>
        <Heart size={12} fill="currentColor" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={[frame, "font-display text-text", large ? "gap-1 py-0.5 pr-2 pl-1.5 text-[12px]" : "gap-1 py-px pr-1.5 pl-1 text-[10.5px]"].join(" ")}>
      <Heart size={large ? 13 : 11} fill="currentColor" aria-hidden="true" className="text-hp" />
      {word}
    </span>
  );
}
