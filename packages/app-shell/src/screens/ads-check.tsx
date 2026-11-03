import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AdShowOutcome } from "@bh/shared-types";
import { Button, ContentColumn, InfoNotice, ListGroup, ListItem, Screen, SectionTitle } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/team";
import { adsPlayable } from "../state/ad-watch";
import { browserAdsCheckDeps, createAdsCheckApi, runAdCheck, type AdsCheckCatalog } from "../state/ads-check";
import { useNavigation } from "../state/navigation";
import { useToolsAccess } from "../state/tools";
import { adsCheckView, groupCatalog, outcomeLabel, placeLabel, type AdsCheckBlock, type AdsCheckLoad, type AdsCheckNetwork } from "./ads-check-rules";

/**
 * Проверка рекламы командой (docs/35-stage4-plan.md, Р165; tasks/T-0334): показ
 * блока сети одной кнопкой, мимо сессий выдачи. Сервер проверяет право
 * `tools.dev` сам; здесь оно только прячет экран от остальных.
 */
export function AdsCheckScreen(): ReactNode {
  const navigation = useNavigation();
  const admin = useToolsAccess().admin;
  const playable = adsPlayable();
  const [catalog, setCatalog] = useState<AdsCheckCatalog | null>(null);
  const [load, setLoad] = useState<AdsCheckLoad>("loading");
  const [live, setLive] = useState(false);
  const [startLike, setStartLike] = useState(false);
  const [showing, setShowing] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { outcome: AdShowOutcome; ms: number }>>({});

  const reload = useCallback((): void => {
    setLoad("loading");
    void createAdsCheckApi()
      .catalog()
      .then((response) => {
        if (!response.ok) return setLoad("error");
        setCatalog(response.data);
        setLoad(response.data.networks.length === 0 ? "empty" : "ready");
      });
  }, []);

  useEffect(() => {
    if (!admin) navigation.pop();
    else if (playable) reload();
  }, [admin, playable, reload, navigation]);

  const view = adsCheckView(admin, playable, load);

  const show = (block: AdsCheckBlock, network: AdsCheckNetwork): void => {
    // Второй показ разом невозможен: флаг ставится в том же нажатии.
    if (showing !== null) return;
    setShowing(block.blockId);
    setResults(({ [block.blockId]: _dropped, ...rest }) => rest);
    void runAdCheck(browserAdsCheckDeps(), block, network, { live, startLike }).then((result) => {
      setResults((current) => ({ ...current, [block.blockId]: result }));
      setShowing(null);
    });
  };

  return (
    <Screen title={t("adsCheck.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {view === "denied" ? <p className="mt-3 text-sm text-text-muted">{t("adsCheck.denied")}</p> : null}
        {view === "unsupported" ? <p className="mt-3 text-sm text-text-muted">{t("adsCheck.unsupported")}</p> : null}
        {view === "loading" ? <p className="mt-3 text-sm text-text-muted">{t("adsCheck.loading")}</p> : null}
        {view === "empty" ? <p className="mt-3 text-sm text-text-muted">{t("adsCheck.empty")}</p> : null}
        {view === "error" ? (
          <div className="mt-3 flex flex-col items-start gap-3">
            <p className="text-sm text-text-muted">{t("adsCheck.error")}</p>
            <Button track="retry" onClick={reload}>
              {t("adsCheck.retry")}
            </Button>
          </div>
        ) : null}
        {view === "ready" && catalog !== null ? (
          <>
            <p className="mt-1 text-xs text-text-muted">{t("adsCheck.intro")}</p>
            <div className="mt-3">
              <ListGroup>
                <ListItem title={t("adsCheck.live")} hint={t("adsCheck.live.hint")} toggle={{ checked: live, onChange: () => setLive(!live) }} />
                <ListItem title={t("adsCheck.startLike")} hint={t("adsCheck.startLike.hint")} toggle={{ checked: startLike, onChange: () => setStartLike(!startLike) }} />
              </ListGroup>
              {live ? <InfoNotice text={t("adsCheck.live.warning")} /> : null}
            </div>
            {groupCatalog(catalog.networks, catalog.blocks).map((group) => (
              <div key={group.network.network}>
                <SectionTitle>{group.network.active ? group.network.name : `${group.network.name} · ${t("adsCheck.network.off")}`}</SectionTitle>
                {group.network.network === "adsonar" ? <p className="mb-2 text-xs text-text-muted">{t("adsCheck.sonarNote")}</p> : null}
                <div className="flex flex-col gap-2">
                  {group.blocks.map((block) => {
                    const result = results[block.blockId];
                    return (
                      <div key={block.blockId} className="rounded-md border border-border p-3">
                        <div className="text-sm font-semibold">
                          {placeLabel(block.place)} · {t(`adsCheck.format.${block.format}`)}
                          {block.active ? "" : ` · ${t("adsCheck.block.off")}`}
                        </div>
                        <div className="mt-1 break-all text-xs text-text-muted">
                          {block.externalId === null ? t("adsCheck.block.noId") : t("adsCheck.block.id", { id: block.externalId })}
                        </div>
                        <div className="mt-2">
                          <Button track="show" disabled={showing !== null} onClick={() => show(block, group.network)}>
                            {showing === block.blockId ? t("adsCheck.showing") : t("adsCheck.show")}
                          </Button>
                        </div>
                        {result === undefined ? null : <div className="mt-2 text-sm">{outcomeLabel(result.outcome, result.ms)}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        ) : null}
      </ContentColumn>
    </Screen>
  );
}
