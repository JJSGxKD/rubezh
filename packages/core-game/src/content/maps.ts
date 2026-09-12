import type { MapDef } from "@bh/shared-types";

// Карты — данные, как враги и оружие (docs/01-tech-stack.md §9). На старте
// карта одна: решение Р8 этапа 2 — сейчас важнее механики и работа приложения
// целиком, а не разнообразие локаций (docs/26-stage2-plan.md §2).
//
// Мир бесконечен: `bounds` не заданы. Границы — особенность конкретной карты,
// а не свойство движка (решение Р3); чтобы запереть игрока в коридоре, карте
// хватит одной строки `bounds: { halfWidth: 1800 }`, и спавн сам перестанет
// выбирать дуги за краем.
//
// Числа камеры — в игровых единицах, а видимая область задана **площадью**:
// портрет и ландшафт видят одинаковый объём мира разной формы (решение Р14).
// Размер экрана и плотность пикселей на объём мира не влияют вовсе.

export const MAPS: MapDef[] = [
  {
    id: "frontier",
    nameKey: "map.frontier.name",
    camera: {
      viewAreaMoving: 260_000,
      viewAreaIdle: 175_000,
      maxAspect: 2.2,
      followSmoothingSec: 0.12,
      zoomSmoothingSec: 0.5,
      zoomInDelaySec: 0.7,
    },
  },
];

export const DEFAULT_MAP_ID = MAPS[0].id;

/** Карта по id; неизвестный id — это ошибка данных, а не повод молча играть. */
export function findMap(id: string): MapDef | undefined {
  return MAPS.find((map) => map.id === id);
}
