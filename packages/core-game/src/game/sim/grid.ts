// Равномерная пространственная сетка для поиска соседей.
//
// Почему не попарный перебор: при 200 врагах и 100 снарядах наивная проверка
// даёт десятки тысяч сравнений на тик, и FPS-испытание этапа 1 померит
// качество нашего алгоритма, а не потолок движка (docs/02-roadmap.md, этап 1).
// Тест бюджета производительности (docs/17-testing-strategy.md §3.4) ловит
// возврат к квадратичной проверке в CI.
//
// Сетка построена **вокруг игрока**, а не под размер мира: мир бесконечен, и
// сетки под него не существует (docs/26-stage2-plan.md, WP4.1). Окно
// фиксированного размера переезжает вместе с игроком, и при перестроении
// меняется только начало координат — память выделяется один раз, в
// конструкторе. Аллокации внутри игрового кадра — это работа сборщику мусора,
// а его паузы на бюджетном Android видны как фризы и портят замер p99.

/**
 * Размер клетки — порядка диаметра крупного врага: мельче даёт много пустых
 * клеток на запрос, крупнее возвращает лишних кандидатов. Живёт рядом с
 * сеткой, а не в мире: это её свойство.
 */
export function gridCellSize(unitScale: number): number {
  return 48 * unitScale;
}

export class SpatialGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellSize: number;
  private readonly counts: Int32Array;
  private readonly starts: Int32Array;
  private readonly cursor: Int32Array;
  private readonly items: Int32Array;
  private originX = 0;
  private originY = 0;

  /**
   * `extent` — сторона окна, которое сетка накрывает вокруг центра. Всё, что
   * дальше, попадает в краевые клетки: такие объекты живут считанные тики —
   * шаг симуляции уносит отставших врагов вперёд, а снаряды и кристаллы за
   * радиусом удержания гибнут.
   */
  constructor(extent: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(extent / cellSize));
    this.rows = this.cols;
    const cellCount = this.cols * this.rows;
    this.counts = new Int32Array(cellCount);
    this.starts = new Int32Array(cellCount + 1);
    this.cursor = new Int32Array(cellCount);
    this.items = new Int32Array(capacity);
  }

  /**
   * Перестроить сетку по текущим позициям вокруг центра. Сортировка
   * подсчётом: два прохода по массиву, без аллокаций и без сравнения
   * элементов.
   */
  rebuild(
    centerX: number,
    centerY: number,
    xs: Float64Array,
    ys: Float64Array,
    alive: Uint8Array,
    count: number,
  ): void {
    this.originX = centerX - (this.cols * this.cellSize) / 2;
    this.originY = centerY - (this.rows * this.cellSize) / 2;
    this.counts.fill(0);

    for (let i = 0; i < count; i++) {
      if (alive[i] === 0) continue;
      this.counts[this.cellIndex(xs[i], ys[i])]++;
    }

    let running = 0;
    for (let cell = 0; cell < this.counts.length; cell++) {
      this.starts[cell] = running;
      this.cursor[cell] = running;
      running += this.counts[cell];
    }
    this.starts[this.counts.length] = running;

    for (let i = 0; i < count; i++) {
      if (alive[i] === 0) continue;
      const cell = this.cellIndex(xs[i], ys[i]);
      this.items[this.cursor[cell]++] = i;
    }
  }

  /**
   * Сложить индексы кандидатов в радиусе в готовый буфер и вернуть их число.
   * Буфер снаружи, а не результат-массив: возврат нового массива на каждый
   * запрос — это сотни аллокаций в кадр.
   *
   * Возвращаются кандидаты по клеткам, а не точное попадание в круг: точную
   * дистанцию считает вызывающий код, ему всё равно нужен квадрат расстояния.
   */
  queryInto(x: number, y: number, radius: number, out: Int32Array): number {
    const minCol = this.clampCol(Math.floor((x - radius - this.originX) / this.cellSize));
    const maxCol = this.clampCol(Math.floor((x + radius - this.originX) / this.cellSize));
    const minRow = this.clampRow(Math.floor((y - radius - this.originY) / this.cellSize));
    const maxRow = this.clampRow(Math.floor((y + radius - this.originY) / this.cellSize));

    let found = 0;
    for (let row = minRow; row <= maxRow; row++) {
      const rowOffset = row * this.cols;
      for (let col = minCol; col <= maxCol; col++) {
        const cell = rowOffset + col;
        const end = this.starts[cell + 1];
        for (let slot = this.starts[cell]; slot < end; slot++) {
          if (found >= out.length) return found;
          out[found++] = this.items[slot];
        }
      }
    }
    return found;
  }

  private cellIndex(x: number, y: number): number {
    const col = this.clampCol(Math.floor((x - this.originX) / this.cellSize));
    const row = this.clampRow(Math.floor((y - this.originY) / this.cellSize));
    return row * this.cols + col;
  }

  private clampCol(col: number): number {
    return col < 0 ? 0 : col >= this.cols ? this.cols - 1 : col;
  }

  private clampRow(row: number): number {
    return row < 0 ? 0 : row >= this.rows ? this.rows - 1 : row;
  }
}
