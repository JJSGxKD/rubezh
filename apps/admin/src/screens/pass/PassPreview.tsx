import { describeReward, monthTitle, type PassReward, type PassSeason } from "../../api/pass";
import { Dialog } from "../../ui/dialog";
import { Button } from "../../ui/kit";

/**
 * Предпросмотр ленты: две дорожки по 30 ступеней, как их увидит игрок, но без
 * его данных — ни очков, ни забранного. Это панельная раскладка: готовый экран
 * игрока (tasks/T-0314) в рамку телефона подключит его задача.
 */
export function PassPreview({ season, onClose }: { season: PassSeason; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} title={`Предпросмотр — ${monthTitle(season.monthKey)}`} description="Так ленту увидит игрок: каждая ступень, бесплатная и VIP награда. Очки и забранное не показываются." size="wide" footer={<Button onClick={onClose}>Закрыть</Button>}>
      <div className="flex flex-col gap-4">
        <Lane title="Бесплатная лента" season={season} lane="free" />
        <Lane title="VIP-лента" season={season} lane="vip" />
      </div>
    </Dialog>
  );
}

function Lane({ title, season, lane }: { title: string; season: PassSeason; lane: "free" | "vip" }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
        {season.tiers.map((tier) => {
          const reward: PassReward = tier[lane];
          return (
            <li key={tier.tier} className="rounded-sm border border-border bg-surface-sunken p-2 text-xs">
              <span className="mb-1 block font-semibold text-text-muted">Ступень {tier.tier}</span>
              {describeReward(reward)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
