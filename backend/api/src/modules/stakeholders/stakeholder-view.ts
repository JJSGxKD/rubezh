import { MAX_SHARE_BP, shareAt, type ShareRecord } from "./stakeholder-rules.js";
import type { ParticipantRow, StoredShare } from "./stakeholders.repository.js";

/**
 * Ответ панели «Участники» (docs/35-stage4-plan.md Р217, tasks/T-0452): собирается из строк хранилища чистой
 * функцией — без базы и без прав, чтобы правила «текущая», «ближайшая» и «остаток владельцу» читались и
 * проверялись отдельно от сервиса.
 */

/** Доля с месяца, на котором она начала действовать. */
export interface ShareStanding {
  sharePercent: number;
  /** `ГГГГ-ММ` */
  fromMonth: string;
}

/** Строка истории. `note` и `setBy` — внутренние записи владельца: участнику их не отдают, самих полей нет. */
export interface ShareHistoryEntry {
  sharePercent: number;
  fromMonth: string;
  note?: string;
  /** имя того, кто назначил долю */
  setBy?: string;
  /** ISO-время записи */
  setAt: string;
}

export interface ParticipantView {
  accountId: string;
  name: string;
  /** роль «Участник проекта» сейчас; снятие роли доли не стирает */
  hasRole: boolean;
  /** доля на текущий месяц; нулевая доля и отсутствие записей — `null` */
  current: ShareStanding | null;
  /** ближайшая запись после текущего месяца (в том числе 0 % — конец участия); `null` — будущих записей нет */
  next: ShareStanding | null;
  /** новые месяцы сверху */
  history: ShareHistoryEntry[];
}

export interface StakeholdersView {
  /** текущий месяц, `ГГГГ-ММ` */
  month: string;
  participants: ParticipantView[];
  /** 100 % минус сумма долей участников на текущий месяц: доля владельца */
  ownerSharePercent: number;
}

export interface ViewInput {
  month: string;
  participants: readonly ParticipantRow[];
  history: readonly StoredShare[];
  /** показывать причины и авторов: тому, кто видит все доли (`revenue.split.view`), а не только свою (`own`) */
  detailed: boolean;
}

const standing = (record: Pick<ShareRecord, "fromMonth" | "shareBp">): ShareStanding => ({ sharePercent: record.shareBp / 100, fromMonth: record.fromMonth });

export function stakeholdersView(input: ViewInput): StakeholdersView {
  const { month, detailed } = input;
  const byAccount = new Map<string, StoredShare[]>();
  for (const row of input.history) {
    const list = byAccount.get(row.accountId);
    if (list === undefined) byAccount.set(row.accountId, [row]);
    else list.push(row);
  }

  const participants = input.participants.map((participant) => {
    const rows = byAccount.get(participant.accountId) ?? [];
    const currentBp = shareAt(rows, month);

    // Запись, которая действует сейчас: последняя с месяцем не позже текущего
    const active = rows.filter((row) => row.fromMonth <= month).sort((a, b) => (a.fromMonth < b.fromMonth ? 1 : -1))[0];
    // Ближайшая будущая: самая ранняя с месяцем позже текущего
    const upcoming = rows.filter((row) => row.fromMonth > month).sort((a, b) => (a.fromMonth < b.fromMonth ? -1 : 1))[0];

    const view: ParticipantView = {
      accountId: participant.accountId,
      name: participant.displayName,
      hasRole: participant.hasRole,
      current: active === undefined || currentBp === 0 ? null : standing(active),
      next: upcoming === undefined ? null : standing(upcoming),
      history: [...rows]
        .sort((a, b) => (a.fromMonth < b.fromMonth ? 1 : a.fromMonth > b.fromMonth ? -1 : 0))
        .map((row) => ({
          sharePercent: row.shareBp / 100,
          fromMonth: row.fromMonth,
          ...(detailed ? { note: row.note, setBy: row.setByName } : {}),
          setAt: row.setAt.toISOString(),
        })),
    };
    return { view, currentBp };
  });

  // Большая доля выше; при равных — по имени, затем по идентификатору: порядок не прыгает между запросами
  participants.sort((a, b) => b.currentBp - a.currentBp || a.view.name.localeCompare(b.view.name, "ru") || (a.view.accountId < b.view.accountId ? -1 : 1));

  // Остаток владельцу — от всех строк, а не только от попавших в список: сумма долей не должна зависеть от выборки
  let totalBp = 0;
  for (const rows of byAccount.values()) totalBp += shareAt(rows, month);

  return { month, participants: participants.map((entry) => entry.view), ownerSharePercent: (MAX_SHARE_BP - totalBp) / 100 };
}
