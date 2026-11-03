import { ValidationError } from "../../common/domain-error.js";
import { storedNameFor, type Account, type AccountRepository } from "../auth/account.repository.js";
import { cleanName } from "../auth/display-name.js";
import type { RolesService, AccountRef } from "../roles/roles.service.js";
import { AccountNotFoundError } from "./admin-errors.js";

/**
 * Ручная смена ника в карточке игрока (tasks/T-0151): модератор с правом
 * `players.ban` задаёт ник и закрепляет его — вход с площадки закреплённый ник
 * не перезаписывает. Вынесено из `AdminPlayersService`, чтобы тот не рос.
 */

/** Ник и закрепление для журнала: было → стало. */
function nameState(account: Account): { displayName: string; nameLocked: boolean } {
  return { displayName: account.displayName, nameLocked: account.nameLockedAt != null };
}

async function existing(accounts: AccountRepository, accountId: string): Promise<Account> {
  const account = await accounts.byId(accountId);
  if (account === null) throw new AccountNotFoundError();
  return account;
}

/**
 * Сменить ник и закрепить. Ручной ник проходит ту же чистку, что и ник с
 * площадки (T-0149): иначе ручная смена обошла бы её.
 */
export async function renameAccount(accounts: AccountRepository, roles: RolesService, actor: AccountRef, accountId: string, name: string, now: Date): Promise<Account> {
  await roles.require(actor, "players.ban");
  const before = await existing(accounts, accountId);

  const cleaned = cleanName(name);
  if (cleaned.name === null) throw new ValidationError(`Ник не прошёл проверку: ${cleaned.verdict}`);

  const after = await accounts.setName(accountId, cleaned.name, now);
  if (after === null) throw new AccountNotFoundError();
  await roles.audit({ actorAccountId: actor.accountId, action: "players.rename", target: accountId, before: nameState(before), after: nameState(after) });
  return after;
}

/** Снять закрепление: ник снова берётся с площадки — той же функцией, что при входе (`storedNameFor`), чтобы они не разошлись. */
export async function unlockAccountName(accounts: AccountRepository, roles: RolesService, actor: AccountRef, accountId: string): Promise<Account> {
  await roles.require(actor, "players.ban");
  const before = await existing(accounts, accountId);

  const restored = storedNameFor(before.platformName ?? before.displayName, before.username, accountId).name;
  const after = await accounts.setName(accountId, restored, null);
  if (after === null) throw new AccountNotFoundError();
  await roles.audit({ actorAccountId: actor.accountId, action: "players.rename.unlock", target: accountId, before: nameState(before), after: nameState(after) });
  return after;
}
