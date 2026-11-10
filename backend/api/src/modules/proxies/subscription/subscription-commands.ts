import { SubscriptionBusyError, SubscriptionLimitError, SubscriptionNotFoundError } from "../proxies-errors.js";
import { slotQuota, SUBSCRIPTIONS_MAX, trimToQuota } from "./subscription-rules.js";
import type { StoredSubscription, SubscriptionRepository } from "./subscription.repository.js";
import type { SubscriptionSync } from "./subscription.sync.js";
import { SidecarMissingError, type ConfigPart, type ConfigWriter } from "./xray-config-writer.js";

/**
 * Правки подписок, которые меняют конфиг Xray (docs/35-stage4-plan.md Р192,
 * tasks/T-0384): создание, смена адреса, включение и выключение, удаление. Все
 * идут под общим замком `proxy-subscription:refresh:lock`; занят — `SubscriptionBusyError`,
 * и в базу ничего не пишется.
 *
 * **Конфиг раньше таблицы.** Если порядок обратный и запись конфига сорвалась,
 * слоты, которые база уже отдала другой подписке, остались бы в конфиге за
 * прежним узлом, и запрос ушёл бы не через тот выход. Поэтому сначала файлы тома
 * (части и `config.json`), потом база; сорвалась запись конфига — база не тронута.
 *
 * Нет каталога тома (контейнер Xray не подключён, dev) — файлы пропускаются, а
 * правка в базе делается: панель покажет «не подключён», как и раньше.
 */

export interface CommandsDeps {
  repository: SubscriptionRepository;
  writer: ConfigWriter;
  sync: SubscriptionSync;
  xray: { slotCount: number };
}

export class SubscriptionCommands {
  constructor(private readonly deps: CommandsDeps) {}

  /**
   * Новая подписка. Её доля входов — `slotCount / (число подписок + 1)`: у остальных
   * узлы сверх доли снимаются (не отвечающие, затем не проверенные, затем с большей
   * задержкой), чтобы новой было куда встать.
   */
  async create(row: StoredSubscription): Promise<void> {
    await this.locked(async () => {
      const all = await this.deps.repository.list();
      if (all.length >= SUBSCRIPTIONS_MAX) throw new SubscriptionLimitError(SUBSCRIPTIONS_MAX);
      const quota = slotQuota(this.deps.xray.slotCount, all.length + 1);
      const trims = all.flatMap(({ subscription, nodes }) => {
        const dropped = trimToQuota(nodes, quota).map((node) => node.nodeKey);
        return dropped.length === 0 ? [] : [{ key: subscription.key, dropped }];
      });
      if (trims.length > 0) await this.trimFiles(trims);
      for (const { key, dropped } of trims) await this.deps.repository.dropNodes(key, dropped);
      await this.deps.repository.create(row);
    });
  }

  /**
   * Правка. Смена адреса — другая подписка: часть, узлы и входы прежнего адреса
   * уходят из конфига, итог сбрасывается. Смена `enabled` перекладывает подписку
   * в конфиг или из него, не загружая её заново. Название и страны конфиг не
   * меняют и замка не ждут.
   */
  async update(before: StoredSubscription, row: StoredSubscription, replaced: boolean): Promise<void> {
    if (replaced) {
      await this.locked(async () => {
        await this.dropFromConfig(row.key);
        if (!(await this.deps.repository.save(row, { dropNodes: true }))) throw new SubscriptionNotFoundError();
      });
      return;
    }
    if (before.enabled !== row.enabled) {
      await this.locked(async () => {
        if (!(await this.deps.repository.save(row))) throw new SubscriptionNotFoundError();
        try {
          await this.assemble();
        } catch (error: unknown) {
          // Конфиг не собрался: включение, которого в конфиге нет, не оставляем.
          await this.deps.repository.save(before).catch(() => undefined);
          throw error;
        }
      });
      return;
    }
    if (!(await this.deps.repository.save(row))) throw new SubscriptionNotFoundError();
  }

  async remove(key: string): Promise<void> {
    await this.locked(async () => {
      if ((await this.deps.repository.load(key)) === null) throw new SubscriptionNotFoundError();
      await this.dropFromConfig(key);
      await this.deps.repository.remove(key);
    });
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const result = await this.deps.sync.exclusive(work);
    if (!result.ran) throw new SubscriptionBusyError();
    return result.value;
  }

  /** Собрать конфиг; нет каталога тома — не ошибка (dev). */
  private async assemble(): Promise<void> {
    try {
      await this.deps.sync.assemble();
    } catch (error: unknown) {
      if (!(error instanceof SidecarMissingError)) throw error;
    }
  }

  /** Убрать часть подписки и пересобрать конфиг без неё. */
  private async dropFromConfig(key: string): Promise<void> {
    await this.deps.writer.removePart(key);
    await this.assemble();
  }

  /**
   * Переписать части подписок без снимаемых узлов и пересобрать конфиг. Сорвалось —
   * части возвращаются как были, чтобы том и база говорили одно.
   */
  private async trimFiles(trims: readonly { key: string; dropped: readonly string[] }[]): Promise<void> {
    const originals = new Map<string, ConfigPart>();
    try {
      for (const { key, dropped } of trims) {
        const part = await this.deps.writer.readPart(key);
        if (part === null) continue;
        originals.set(key, part);
        await this.deps.writer.writePart(key, { ...part, nodes: part.nodes.filter((entry) => !dropped.includes(entry.node.key)) });
      }
      await this.deps.sync.assemble();
    } catch (error: unknown) {
      for (const [key, part] of originals) await this.deps.writer.writePart(key, part).catch(() => undefined);
      if (!(error instanceof SidecarMissingError)) throw error;
    }
  }
}
