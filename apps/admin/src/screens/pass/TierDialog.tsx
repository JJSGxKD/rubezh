import { useState, type FormEvent } from "react";
import { RARITIES, draftProblem, draftReward, rewardDraft, saveTier, type PassSeason, type PassTier, type RewardDraft } from "../../api/pass";
import { api } from "../../services";
import { FormDialog, isDirty } from "../../ui/form-dialog";
import { Button, Field, FieldRow, Input, Notice, Select } from "../../ui/kit";

const RARITY_LABELS: Record<(typeof RARITIES)[number], string> = { common: "Обычные", uncommon: "Добротные", rare: "Редкие", epic: "Эпические", legendary: "Легендарные", mythic: "Мифические" };

interface Draft {
  free: RewardDraft;
  vip: RewardDraft;
}

/**
 * Правка одной ступени: награда каждой ленты — вид и число. Пустое поле и ноль —
 * «этого в награде нет»; случайного в форме нет вовсе (Р11). Пределы количеств
 * приходят с сервера, остальное — правила сервера (пройденные ступени, потолок
 * суток кошелька): его отказ показывается здесь же, в окне.
 */
export function TierDialog({ season, tier, onClose, onSaved }: { season: PassSeason; tier: PassTier; onClose: () => void; onSaved: (tier: number) => void }) {
  const initial: Draft = { free: rewardDraft(tier.free), vip: rewardDraft(tier.vip) };
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = draftProblem(draft.free, season.caps, season.boosts) ?? draftProblem(draft.vip, season.caps, season.boosts);
  const freeProblem = draftProblem(draft.free, season.caps, season.boosts);
  const vipProblem = draftProblem(draft.vip, season.caps, season.boosts);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    setError(null);
    const result = await saveTier(api, season.monthKey, tier.tier, { free: draftReward(draft.free), vip: draftReward(draft.vip) });
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    onSaved(tier.tier);
  };

  return (
    <FormDialog
      open
      title={`Ступень ${String(tier.tier)}`}
      dirty={isDirty(initial, draft)}
      onClose={onClose}
      footer={(requestClose) => (
        <>
          <Button onClick={requestClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="pass-tier-form" disabled={problem !== null || pending} blockedBy={pending ? null : problem}>
            Сохранить
          </Button>
        </>
      )}
    >
      <form id="pass-tier-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <Lane title="Бесплатная лента" value={draft.free} problem={freeProblem} season={season} onChange={(free) => setDraft({ ...draft, free })} />
        <Lane title="VIP-лента" value={draft.vip} problem={vipProblem} season={season} onChange={(vip) => setDraft({ ...draft, vip })} />
        {error === null ? null : <Notice>{error}</Notice>}
      </form>
    </FormDialog>
  );
}

function Lane({ title, value, problem, season, onChange }: { title: string; value: RewardDraft; problem: string | null; season: PassSeason; onChange: (value: RewardDraft) => void }) {
  const set = (patch: Partial<RewardDraft>) => onChange({ ...value, ...patch });
  const number = (key: keyof RewardDraft, label: string, cap: number | undefined) => (
    <Field label={label} {...(cap === undefined ? {} : { hint: `до ${String(cap)}` })}>
      <Input inputMode="numeric" value={value[key]} onChange={(event) => set({ [key]: event.target.value })} className="w-28" />
    </Field>
  );
  return (
    <fieldset className="flex flex-col gap-3 rounded-sm border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <FieldRow>
        {number("coins", "Монеты", season.caps.coins)}
        {number("gems", "Самоцветы", season.caps.gems)}
      </FieldRow>
      <FieldRow>
        {RARITIES.map((rarity) => (
          <div key={rarity}>{number(rarity, RARITY_LABELS[rarity], season.caps[`shard_${rarity}`])}</div>
        ))}
      </FieldRow>
      <FieldRow>
        <Field label="Буст в подарок">
          <Select value={value.boostId} onChange={(event) => set({ boostId: event.target.value, boostCount: event.target.value === "" ? "" : value.boostCount === "" ? "1" : value.boostCount })}>
            <option value="">без буста</option>
            {season.boosts.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Сколько бустов">
          <Input inputMode="numeric" value={value.boostCount} disabled={value.boostId === ""} onChange={(event) => set({ boostCount: event.target.value })} className="w-24" />
        </Field>
      </FieldRow>
      {problem === null ? null : <p className="text-xs text-danger">{problem}</p>}
    </fieldset>
  );
}
