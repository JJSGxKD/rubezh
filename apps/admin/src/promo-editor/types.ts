import type { PartnerEdits, PromoDoc, PromoVars } from "@bh/promo-kit";
import type { Mode } from "./fabric-doc";

/** Картинка набора пресета: id в документе (`{ media: id }`) и адрес, по которому её видно. */
export interface PromoAsset {
  id: string;
  url: string;
  name?: string;
}

/**
 * Откуда редактор берёт и куда кладёт картинки команды. Загрузку с профилем
 * `promo_asset` даёт экран, в который редактор встроен (T-0275): сам редактор
 * сети не знает.
 */
export interface PromoAssets {
  /** уже загруженные картинки пресета */
  list(): Promise<PromoAsset[]>;
  /** загрузить файл, отдать id картинки */
  upload(file: File): Promise<string>;
}

export interface PromoEditorProps {
  /**
   * Документ. В режиме команды — то, что правят; в режиме партнёра — шаблон,
   * поверх которого копятся правки. Чтобы открыть другой документ, у
   * редактора меняют `key`.
   */
  doc: PromoDoc;
  mode?: Mode;
  /** значения переменных `{code}`, `{link}`, `{reward}`; нет значения — на холсте видна заглушка */
  vars?: PromoVars;
  assets?: PromoAssets;
  /** новый документ после каждой правки, отмены и повтора; у партнёра — ещё и его правки */
  onChange?: (doc: PromoDoc, edits: PartnerEdits | null) => void;
}
