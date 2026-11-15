import { useState, type ReactNode } from "react";
import { countryName, flagSrc } from "./country-codes";

/** Флаг и код страны рядом; кода нет — «—», флага нет — только код (Р201). */
export function CountryFlag({ code }: { code: string | null }): ReactNode {
  const [failed, setFailed] = useState(false);
  const clean = code === null ? "" : code.trim().toUpperCase();
  if (clean === "") return <span className="text-text-muted">—</span>;
  const src = flagSrc(clean);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap align-middle" title={countryName(clean)}>
      {src === null || failed ? null : (
        <img
          src={src}
          alt=""
          width={21}
          height={16}
          loading="lazy"
          decoding="async"
          className="shrink-0 rounded-[2px]"
          onError={() => setFailed(true)}
        />
      )}
      <span>{clean}</span>
    </span>
  );
}
