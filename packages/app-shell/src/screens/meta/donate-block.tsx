import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Heart } from "lucide-react";
import { Button, Card } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/donate";
import { createDonationsApi, openTribute, type DonationView } from "../../state/donations-api";
import { useSession } from "../../state/session";
import { hasAnyWay, visibleWays, type VisibleWays } from "./donate-rules";
import { SupporterBadge } from "./supporter-badge";

/**
 * Блок «Поддержать проект» на «Об игре» и в профиле (docs/35-stage4-plan.md,
 * Р109, T-0158; макет design/art/mockups/donate-v2.html). Донат — поддержка,
 * а не покупка: об этом сказано прямо в тексте, игровых наград нет.
 *
 * Что показать, решает сервер одним ответом: нет ни одного способа, нет сети
 * или ответ не разобрался — блока нет и ошибки нет: поддержка не критична и не
 * должна пугать красным. Пока ответ в пути, блок места не занимает.
 *
 * Лист доната — отдельным чанком: он нужен после нажатия, а блок стоит на
 * экране, который игрок открывает ради другого.
 */

const DonateSheet = lazy(async () => ({ default: (await import("./donate-sheet")).DonateSheet }));

const api = createDonationsApi();

export function DonateBlock(props: { place: "about" | "profile" }): ReactNode {
  const [view, setView] = useState<DonationView | null>(null);
  const [sheet, setSheet] = useState(false);
  const signedIn = useSession((state) => state.status === "ready");

  const load = async (): Promise<void> => {
    const response = await api.view();
    setView(response.ok ? response.data : null);
  };

  // Вход наладился позже блока — спрашиваем заново: без сессии сервер не отвечал.
  useEffect(() => {
    let alive = true;
    void api.view().then((response) => {
      if (alive) setView(response.ok ? response.data : null);
    });
    return () => {
      alive = false;
    };
  }, [signedIn]);

  if (view === null || !hasAnyWay(view)) return null;
  const ways = visibleWays(view);

  return (
    <div className="mt-4">
      <DonateCard view={view} place={props.place} onSheet={() => setSheet(true)} onTribute={(tribute) => openTribute(tribute, props.place)} />
      {sheet ? (
        <Suspense fallback={null}>
          <DonateSheet
            stars={view.stars}
            tribute={ways.tribute}
            place={props.place}
            onClose={() => setSheet(false)}
            // Знак встал в сессию; блок сразу говорит «уже у тебя» и перечитывает ответ сервера.
            onDone={() => {
              setView({ ...view, supporter: true });
              void load();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * Карточка блока без загрузки: шапка с сердцем, текст и кнопки. У поддержавшего
 * заголовок тот же, под ним — знак и «знак уже у тебя»; в профиле абзаца
 * с объяснением у него нет — знак стоит у имени. Знака игроку, который платил
 * только через Tribute, блок не обещает: за ссылку знака нет.
 */
export function DonateCard(props: {
  view: DonationView;
  place: "about" | "profile";
  onSheet: () => void;
  onTribute: (tribute: NonNullable<VisibleWays["tribute"]>) => void;
}): ReactNode {
  const { view, place } = props;
  const ways = visibleWays(view);
  const supporter = view.supporter;

  return (
    <Card>
      <div className="mb-2 flex items-center gap-3">
        <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-hp ring-2 ring-hp/70">
          <Heart size={20} fill="currentColor" />
        </span>
        <h2 className="min-w-0 font-display text-lg font-bold text-text">{t("donate.title")}</h2>
      </div>
      {supporter ? (
        <p className="mb-2.5 flex flex-wrap items-center gap-2 text-sm text-text">
          {place === "about" ? <SupporterBadge size="l" /> : null}
          <span className="min-w-0">{t("donate.already")}</span>
        </p>
      ) : null}
      {supporter && place === "profile" ? null : <p className="mb-3 text-sm text-text-muted">{t("donate.text")}</p>}
      <div className="grid gap-2 min-[768px]:grid-flow-col min-[768px]:auto-cols-fr">
        {ways.stars ? (
          <Button track="donate_open" block onClick={props.onSheet}>
            <Heart size={18} fill="currentColor" aria-hidden="true" />
            {supporter ? t("donate.again") : t("donate.cta")}
          </Button>
        ) : null}
        {ways.tribute === null ? null : (
          <TributeButton ways={ways} onTribute={props.onTribute} />
        )}
      </div>
    </Card>
  );
}

function TributeButton(props: { ways: VisibleWays; onTribute: (tribute: NonNullable<VisibleWays["tribute"]>) => void }): ReactNode {
  const { tribute } = props.ways;
  if (tribute === null) return null;
  return (
    <Button track="donate_tribute" block variant="secondary" onClick={() => props.onTribute(tribute)}>
      <span className="min-[768px]:hidden">{t("donate.tribute")}</span>
      <span className="hidden min-[768px]:inline">{t("donate.tribute.short")}</span>
      <ExternalLink size={16} aria-hidden="true" />
    </Button>
  );
}
