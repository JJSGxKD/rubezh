/**
 * Сколько самоцветов в горсти на плитке набора. Растёт с размером набора среди
 * всех наборов самоцветов: самый малый — один значок, самый большой — пять,
 * остальные — три; единственный набор тоже получает три. Размер считается от
 * соседей, а не от числа самоцветов: каталог меняется, а плитки должны
 * по-прежнему читаться от малого к большому (design/screens/shop.html).
 */
export function gemPileSize(gems: number, allPacks: readonly number[]): 1 | 3 | 5 {
  if (allPacks.length < 2) return 3;
  if (gems <= Math.min(...allPacks)) return 1;
  if (gems >= Math.max(...allPacks)) return 5;
  return 3;
}
