/**
 * Раскладка тени в текстуре фигуры. Тень запечена в ту же текстуру, что и
 * тело: отдельный спрайт на тень удвоил бы число объектов на слабом телефоне.
 * Чистая функция без Phaser — тесты в test/shadow-layout.test.ts.
 *
 * Тело стоит в центре поля, поэтому точка привязки спрайта — по-прежнему
 * середина, а размер тела на экране (радиус `radius` в пикселях текстуры при
 * масштабе 1) и хитбокс не меняются: растёт только прозрачное поле под тень.
 */
export interface ShadowLayout {
  /** сторона квадратной текстуры */
  size: number;
  /** центр тела в текстуре */
  bodyX: number;
  bodyY: number;
  /** центр эллипса тени */
  shadowX: number;
  shadowY: number;
  /** полуоси эллипса тени */
  shadowRx: number;
  shadowRy: number;
  originX: number;
  originY: number;
}

/** Доля радиуса, которую занимает поле под тень с каждой стороны. */
const PAD_RATIO = 0.4;

export function shadowLayout(radius: number): ShadowLayout {
  const pad = Math.ceil(radius * PAD_RATIO);
  const body = pad + radius;
  return {
    size: Math.ceil(radius * 2) + pad * 2,
    bodyX: body,
    bodyY: body,
    shadowX: body,
    shadowY: body + radius * 0.75,
    shadowRx: radius * 0.9,
    shadowRy: radius * 0.38,
    originX: 0.5,
    originY: 0.5,
  };
}
