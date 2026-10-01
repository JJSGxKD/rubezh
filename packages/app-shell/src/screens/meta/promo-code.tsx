import { useRef, useState, type ReactNode } from "react";
import { Gift } from "lucide-react";
import { Button, ContentColumn, IconEmblem, InfoNotice, Screen, staggerStyle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon } from "../../design-system/components/ShardIcon";
import { formatNumber, t } from "../../i18n";
import "../../i18n/promo";
import { useNavigation } from "../../state/navigation";
import { createPromoApi, errorKey, promoAvailable, rewardLines, type PromoReward, type PromoResult } from "../../state/promo-api";
import { track } from "../../state/shell";
import { uiFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";

/**
 * Промокод (docs/35-stage4-plan.md WP41): поле, кнопка и понятный ответ.
 * Код вводят руками, часто — услышав на стриме, поэтому регистр, пробелы и
 * раскладку сервер не различает, а экран прямо об этом говорит. Ошибка — у
 * поля и своими словами: «кончился срок» и «опечатка» — разные действия для
 * игрока. После активации — что легло и текст команды к коду.
 */

const api = createPromoApi();
/** длиннее кода с приставкой и разделителями не бывает; сервер всё равно проверит */
const CODE_MAX = 40;

export function PromoCodeScreen(): ReactNode {
  const navigation = useNavigation();
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Откуда пришли — для аналитики: находят ли поле в меню или в магазине.
  const source = navigation.stack.at(-2) === "shop" ? "shop" : "menu";

  const submit = async (): Promise<void> => {
    if (code.trim() === "" || sending) return;
    setSending(true);
    setError(null);
    const response = await api.redeem(code.trim());
    setSending(false);
    if (!response.ok) {
      uiFeedback("error");
      setError(t(errorKey(response)));
      input.current?.focus();
      return;
    }
    uiFeedback("reward");
    setResult(response.data);
    const { credited } = response.data;
    track("promo_code_applied", {
      campaign: response.data.campaignId,
      kind: response.data.kind,
      source,
      coins: credited.coins,
      gems: credited.gems,
      shards: credited.shard_common + credited.shard_uncommon,
      capped: response.data.capped,
    });
    void loadWallet();
  };

  const again = (): void => {
    setResult(null);
    setCode("");
    setError(null);
  };

  if (result !== null) {
    return (
      <Screen
        title={t("promo.title")}
        onBack={() => navigation.pop()}
        footer={
          <div className="flex flex-col gap-2">
            <Button size="l" block glow onClick={() => navigation.pop()}>
              {t("promo.done.ok")}
            </Button>
            <Button variant="ghost" block onClick={again}>
              {t("promo.done.more")}
            </Button>
          </div>
        }
      >
        <ContentColumn>
          <div className="mt-6 flex flex-col items-center gap-4 text-center">
            <span className="animate-rise-in">
              <IconEmblem size="l">
                <Gift size={36} />
              </IconEmblem>
            </span>
            <h2 className="font-display text-xl font-bold text-text">{t("promo.done.title")}</h2>
            <RewardTiles reward={result.credited} />
            <p className="max-w-[320px] text-sm text-text-muted">{result.message ?? t("promo.done.default")}</p>
            {result.capped ? <InfoNotice text={t("promo.done.capped")} /> : null}
          </div>
        </ContentColumn>
      </Screen>
    );
  }

  return (
    <Screen
      title={t("promo.title")}
      onBack={() => navigation.pop()}
      footer={
        promoAvailable() ? (
          <Button size="l" block glow disabled={code.trim() === ""} loading={sending} onClick={() => void submit()}>
            {sending ? t("promo.sending") : t("promo.apply")}
          </Button>
        ) : undefined
      }
    >
      <ContentColumn>
        <div className="mt-4 mb-5 flex flex-col items-center gap-3 text-center">
          <IconEmblem size="l">
            <Gift size={36} />
          </IconEmblem>
          <p className="max-w-[320px] text-sm text-text-muted">{t("promo.text")}</p>
        </div>

        {promoAvailable() ? (
          <>
            <input
              ref={input}
              value={code}
              maxLength={CODE_MAX}
              placeholder={t("promo.placeholder")}
              aria-label={t("promo.input")}
              aria-invalid={error !== null}
              aria-describedby="promo-code-note"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="go"
              className={[
                "surface-sunken w-full rounded-md px-4 py-3 text-center font-display text-lg font-bold tracking-widest text-text uppercase",
                "placeholder:text-sm placeholder:font-normal placeholder:tracking-normal placeholder:normal-case placeholder:text-text-disabled",
                error === null ? "" : "ring-1 ring-danger",
              ].join(" ")}
              onChange={(event) => {
                setCode(event.target.value);
                if (error !== null) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            <p id="promo-code-note" role={error === null ? undefined : "alert"} className={`mt-2 text-center text-sm ${error === null ? "text-text-muted" : "text-danger"}`}>
              {error ?? t("promo.hint")}
            </p>
          </>
        ) : (
          <InfoNotice text={t("promo.guest")} />
        )}
      </ContentColumn>
    </Screen>
  );
}

const ICONS: Record<keyof PromoReward, ReactNode> = {
  coins: <CoinIcon size={28} />,
  gems: <GemIcon size={28} />,
  shard_common: <ShardIcon rarity="common" size={28} />,
  shard_uncommon: <ShardIcon rarity="uncommon" size={28} />,
};

/** Колонок столько, сколько плиток, но не больше трёх: четыре — квадратом, а не «три и одна». */
const GRIDS = ["", "max-w-[160px] grid-cols-1", "max-w-[280px] grid-cols-2", "max-w-[320px] grid-cols-3", "max-w-[280px] grid-cols-2"] as const;

/** Что легло — плитками с иконкой: число читается быстрее слова. */
function RewardTiles(props: { reward: PromoReward }): ReactNode {
  const lines = rewardLines(props.reward);
  return (
    <ul className={`grid w-full gap-2 ${GRIDS[lines.length] ?? GRIDS[4]}`}>
      {lines.map((line, index) => (
        <li
          key={line.resource}
          style={staggerStyle(index + 1)}
          aria-label={t(`promo.reward.${line.resource}`, { amount: formatNumber(line.amount), n: line.amount })}
          className="surface-card flex animate-rise-in flex-col items-center gap-1.5 rounded-lg px-3 py-3"
        >
          <span aria-hidden="true">{ICONS[line.resource]}</span>
          <span aria-hidden="true" className="font-display text-lg font-bold tabular-nums text-accent">
            +{formatNumber(line.amount)}
          </span>
        </li>
      ))}
    </ul>
  );
}
