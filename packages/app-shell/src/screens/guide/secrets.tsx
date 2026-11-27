import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod/mini";
import { SECRET_KINDS, type SecretKind } from "@bh/shared-types";
import { SECRET_LOOKS, type SecretSign } from "@bh/core-game";
import { Card } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/guide";
import { apiRequest, type ApiRequest, type ApiResult } from "../../state/api-request";
import { useShell } from "../../state/shell";
import { hex } from "./scenes";

/**
 * Кодекс тайников в гайдбуке (docs/35-stage4-plan.md Р153, design/art/meta-v2.md
 * §5.3, tasks/T-0261): «Найдено: N из 6» и шесть карточек. Найденный вид — облик
 * тайника в его цвете, имя и предание; ненайденный — силуэт и «Ещё не найден»,
 * без имени и без предания: игрок знает, что искать есть что, но не что именно.
 *
 * Какие виды найдены, помнит сервер — по итогам забегов, которые считаются по
 * правилам наград. Справочник не должен ломаться оттого, что кодекс не загрузился:
 * гость, ошибка сети и старый сервер дают раздел без отметок, со строкой пояснения.
 */

const codexSchema = z.object({
  /** найденные виды в каноническом порядке */
  found: z.array(z.enum(SECRET_KINDS)),
});

export type SecretsCodexView = z.infer<typeof codexSchema>;

export interface SecretsCodexApi {
  load(): Promise<ApiResult<SecretsCodexView>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createSecretsCodexApi(request: ApiRequest = apiRequest): SecretsCodexApi {
  return { load: () => request("/api/v1/codex/secrets", codexSchema, { method: "GET" }) };
}

/** Кодекс — только с входом: виды хранятся по аккаунту. */
function codexAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Что знает гайдбук о кодексе:
 * - `loading` — ответа ещё нет;
 * - `ready` — ответ получен;
 * - `error` — сеть или сервер подвели;
 * - `unavailable` — гость, нет входа или сервер без кодекса.
 */
export type SecretsCodexState = { status: "loading" } | { status: "ready"; view: SecretsCodexView } | { status: "error" } | { status: "unavailable" };

/** Отказы, при которых кодекса нет вовсе, а не «не вышло»: повтор не поможет. */
const UNAVAILABLE_FAILURES: ReadonlySet<string> = new Set(["no_identity", "disabled", "unauthorized"]);

export async function loadSecretsCodexState(api: SecretsCodexApi, available: boolean): Promise<SecretsCodexState> {
  if (!available) return { status: "unavailable" };
  const response = await api.load();
  if (response.ok) return { status: "ready", view: response.data };
  return UNAVAILABLE_FAILURES.has(response.failure) ? { status: "unavailable" } : { status: "error" };
}

/** Найденные виды: без ответа сервера — ни одного. */
export function secretsFoundOf(state: SecretsCodexState): readonly SecretKind[] {
  return state.status === "ready" ? state.view.found : [];
}

const codexApi = createSecretsCodexApi();

/** Загружает кодекс при открытии вкладки «Тайники». */
export function useSecretsCodex(): SecretsCodexState {
  const [state, setState] = useState<SecretsCodexState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    void loadSecretsCodexState(codexApi, codexAvailable()).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** Вкладка гайдбука: ответ сервера или пояснение, почему отметок нет. */
export function Secrets(): ReactNode {
  const state = useSecretsCodex();
  if (state.status === "loading") return <div aria-hidden="true" className="surface-sunken h-24 rounded-md" />;
  return (
    <>
      {state.status === "error" ? <p className="text-xs text-text-muted">{t("guidebook.secrets.error")}</p> : null}
      {state.status === "unavailable" ? <p className="text-xs text-text-muted">{t("guidebook.secrets.guest")}</p> : null}
      <SecretsCodex found={secretsFoundOf(state)} />
    </>
  );
}

/** Полоса «Найдено: N из 6» и шесть карточек по видам, в каноническом порядке. */
export function SecretsCodex(props: { found: readonly SecretKind[] }): ReactNode {
  // Чужое значение и повтор в списке счёт не раздувают: считается только то, что есть среди шести видов.
  const known = new Set<string>(props.found);
  const count = SECRET_KINDS.filter((kind) => known.has(kind)).length;
  const total = SECRET_KINDS.length;
  const progress = t("guidebook.secrets.found", { count, total });

  return (
    <>
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-base font-bold text-text">{t("guidebook.secrets")}</h2>
          <span className="shrink-0 font-display text-sm tabular-nums text-text-muted">{progress}</span>
        </div>
        {/* Родной <progress>: значение читают и скринридеры, а раскраска — токенами. */}
        <progress
          value={count}
          max={total}
          aria-label={progress}
          className={[
            "mt-2 block h-2.5 w-full appearance-none overflow-hidden rounded-pill bg-surface-sunken",
            "[&::-webkit-progress-bar]:bg-surface-sunken [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent",
          ].join(" ")}
        />
      </Card>
      {SECRET_KINDS.map((kind, index) => (
        <div key={kind} data-secret={kind}>
          <SecretCard kind={kind} found={known.has(kind)} index={index} />
        </div>
      ))}
    </>
  );
}

/** Карточка вида: найденный — облик, имя и предание, ненайденный — силуэт без них. */
function SecretCard(props: { kind: SecretKind; found: boolean; index: number }): ReactNode {
  return (
    <Card appearIndex={Math.min(props.index, 6)}>
      <div className="flex items-center gap-3">
        <SecretFigure kind={props.kind} found={props.found} />
        <div className="min-w-0">
          {props.found ? (
            <>
              <h3 className="font-display text-base font-bold text-text">{t(`secret.${props.kind}.name`)}</h3>
              <p className="mt-1 text-sm text-text-muted">{t(`secret.${props.kind}.lore`)}</p>
            </>
          ) : (
            <h3 className="font-display text-base font-bold text-text-muted">{t("guidebook.secrets.unknown")}</h3>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Облик вида: круг и знак внутри — столб, ромб, ёлочка, трещина, треугольник,
 * точка с хвостом, — те же цвета и знаки, что у тайника на земле
 * (`SECRET_LOOKS`). Вид читается знаком, а не только тоном: тона близки.
 * Ненайденный — нейтральный силуэт круга со знаком вопроса, цвета вида в нём нет.
 */
function SecretFigure(props: { kind: SecretKind; found: boolean }): ReactNode {
  if (!props.found) {
    return (
      <svg aria-hidden="true" viewBox="0 0 48 48" className="size-14 shrink-0 text-border-strong">
        <circle cx="24" cy="24" r="20" fill="currentColor" opacity={0.25} />
        <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
        <text x="24" y="31" textAnchor="middle" fontSize="20" fontWeight="700" fill="currentColor">
          ?
        </text>
      </svg>
    );
  }
  const look = SECRET_LOOKS[props.kind];
  const color = hex(look.color);
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-14 shrink-0">
      <circle cx="24" cy="24" r="20" fill={hex(look.dark)} stroke={color} strokeWidth="2" />
      <SecretSignMark sign={look.sign} color={color} />
    </svg>
  );
}

function SecretSignMark(props: { sign: SecretSign; color: string }): ReactNode {
  const { color } = props;
  switch (props.sign) {
    case "pillar":
      return <rect x="21.5" y="14" width="5" height="20" fill={color} />;
    case "diamond":
      return <polygon points="24,12 33,24 24,36 15,24" fill={color} />;
    case "fir":
      return (
        <>
          <polygon points="24,12 30,22 18,22" fill={color} />
          <polygon points="24,19 33,34 15,34" fill={color} />
        </>
      );
    case "crack":
      return <polyline points="27,13 20,23 28,26 21,35" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />;
    case "triangle":
      return <polygon points="24,13 33,32 15,32" fill={color} />;
    case "tail":
      return (
        <>
          <circle cx="28" cy="24" r="4.5" fill={color} />
          <polygon points="13,24 24,20 24,28" fill={color} />
        </>
      );
  }
}
