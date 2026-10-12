/**
 * Вид снаряда по тому, чей он. Без Phaser — тесты в test/projectile-look.test.ts.
 *
 * Свой снаряд круглый и без поворота. Спрайты переиспользуются: снаряд игрока
 * в слоте, где раньше летел вражеский, обязан сбросить поворот и сплющивание,
 * поэтому поля пишутся всегда, а не только у вражеского.
 */
export interface ProjectileLook {
  texture: string;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export function projectileLook(fromPlayer: boolean, vx: number, vy: number, out: ProjectileLook): ProjectileLook {
  if (fromPlayer) {
    out.texture = "bh-projectile";
    out.rotation = 0;
    out.scaleX = 1;
    out.scaleY = 1;
    return out;
  }
  // Вражеский снаряд вытянут по полёту: видно не только «что-то летит», а
  // куда именно. Своим это не нужно — они и так летят от игрока. Math.atan2 в
  // рендере разрешён: на исход забега он не влияет.
  out.texture = "bh-projectile-enemy";
  out.rotation = Math.atan2(vy, vx);
  out.scaleX = 1.15;
  out.scaleY = 0.8;
  return out;
}
