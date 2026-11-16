import type { PublicIdentitySource, PublicMark } from "../../common/public-identity.js";
import type { AccountRepository } from "../auth/account.repository.js";

/**
 * Источник публичных id для порта `PublicIdentity` (T-0247): рейтинг, сезон и друзья получают id
 * тем же вызовом, что знак и облик. Один запрос на всю таблицу, сколько бы строк ни было.
 */
export function publicIdSource(accounts: Pick<AccountRepository, "publicIds">): PublicIdentitySource {
  return {
    of: async (accountIds) => {
      const found = await accounts.publicIds(accountIds);
      return new Map<string, PublicMark>([...found].map(([accountId, publicId]) => [accountId, { publicId }]));
    },
  };
}
