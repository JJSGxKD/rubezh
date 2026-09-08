import type { UpgradeDef } from "@bh/shared-types";

export const UPGRADES: UpgradeDef[] = [
  { id: "attack_speed_up", name: "Скорость атаки", description: "+10% к скорости атаки", maxStacks: 5 },
  { id: "move_speed_up", name: "Скорость движения", description: "+8% к скорости передвижения", maxStacks: 5 },
  { id: "max_hp_up", name: "Живучесть", description: "+15 к максимальному HP", maxStacks: 5 },
];
