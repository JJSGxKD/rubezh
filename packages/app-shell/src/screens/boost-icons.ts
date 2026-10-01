import { Eye, Heart, Magnet, Plus, Shield, Sparkles, Swords, type LucideIcon } from "lucide-react";

/**
 * Значки бустов — общие у выбора перед забегом и у плашек в забеге: буст,
 * купленный с мечами, в забеге тоже с мечами. Соответствие — в оболочке, а
 * не в контенте: буст без значка получает общий, и геймдизайнер не ждёт
 * правки интерфейса (как у оружия, `item-icons.tsx`).
 */
const BOOST_ICONS: Readonly<Record<string, LucideIcon>> = {
  fury: Swords,
  bulwark: Heart,
  lure: Magnet,
  aegis: Shield,
  head_start: Plus,
  insight: Eye,
};

export function boostIcon(id: string): LucideIcon {
  return BOOST_ICONS[id] ?? Sparkles;
}
