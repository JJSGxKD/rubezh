import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { GENERATED_SECRET_BYTES, secretByKey, secretProblem, type SecretCheckResult, type SecretDefinition } from "../secrets/secret-catalog.js";
import { SecretsService, type SecretSource, type SecretState } from "../secrets/secrets.service.js";
import { SecretMissingError, SecretNotFoundError, SecretNotGeneratedError, SecretUncheckableError } from "./admin-errors.js";

/**
 * Ключи интеграций в панели (docs/35-stage4-plan.md Р84, WP46). Видеть
 * состояние — `secrets.view`, менять — `secrets.edit`. Значение ключа панель
 * не получает никогда: только последние знаки, откуда он и кто менял. В
 * аудит — тоже только знаки: «••••a1f3 → ••••9c2e».
 */

export interface SecretView {
  key: string;
  service: string;
  title: string;
  hint: string;
  cabinetUrl: string | null;
  example: string;
  /** вид ключа — панель проверяет его до отправки тем же правилом */
  pattern: string;
  checkable: boolean;
  /** куда вставить созданный сервером ключ; `null` — ключ берут в кабинете сервиса */
  generated: string | null;
  source: SecretSource;
  fingerprint: string | null;
  envSet: boolean;
  unreadable: boolean;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: Date | null;
}

/**
 * Созданный ключ — один раз: что вставить в кабинет сервиса. `absolute` —
 * адрес полный; нет — на сервере не задан `PUBLIC_API_URL`, и начало адреса
 * человек дописывает сам.
 */
export interface GeneratedSecretView {
  secret: SecretView;
  reveal: string;
  absolute: boolean;
}

export interface SecretsOverview {
  /** можно ли задавать ключи: есть ключ шифрования и база */
  enabled: boolean;
  secrets: SecretView[];
}

@Injectable()
export class AdminSecretsService {
  constructor(
    private readonly secrets: SecretsService,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(actor: AccountRef): Promise<SecretsOverview> {
    await this.roles.require(actor, "secrets.view");
    const states = this.secrets.describe();
    const names = await this.accounts.displayNames([...new Set(states.flatMap((state) => (state.updatedBy === null ? [] : [state.updatedBy])))]);
    return { enabled: this.secrets.enabled, secrets: states.map((state) => viewOf(state, names)) };
  }

  async save(actor: AccountRef, key: string, raw: string): Promise<SecretView> {
    await this.roles.require(actor, "secrets.edit");
    const secret = this.definition(key);
    const value = raw.trim();
    const problem = secretProblem(secret, value);
    if (problem !== null) throw new ValidationError(problem);
    const before = this.state(secret);
    await this.secrets.write(secret, value, actor.accountId);
    const after = this.state(secret);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "secrets.save", target: key, before: auditOf(before), after: auditOf(after) });
    return await this.view(after);
  }

  /**
   * Новый ключ, который создаёт сервер (секрет адреса награды): прежний
   * перестаёт работать сразу. Что вставить в кабинет сервиса, ответ несёт
   * один раз — ни список, ни аудит его не покажут.
   */
  async generate(actor: AccountRef, key: string): Promise<GeneratedSecretView> {
    await this.roles.require(actor, "secrets.edit");
    const secret = this.definition(key);
    if (secret.generated === undefined) throw new SecretNotGeneratedError();
    const value = randomBytes(GENERATED_SECRET_BYTES).toString("base64url");
    const before = this.state(secret);
    await this.secrets.write(secret, value, actor.accountId);
    const after = this.state(secret);
    await this.roles.audit({ actorAccountId: actor.accountId, action: "secrets.generate", target: key, before: auditOf(before), after: auditOf(after) });
    const reveal = secret.generated.reveal(value, this.config);
    return { secret: await this.view(after), reveal, absolute: /^https?:\/\//.test(reveal) };
  }

  /** Сброс к окружению: строка удаляется, и снова работает `.env` сервера. */
  async reset(actor: AccountRef, key: string): Promise<SecretView> {
    await this.roles.require(actor, "secrets.edit");
    const secret = this.definition(key);
    const before = this.state(secret);
    const removed = await this.secrets.clear(secret);
    const after = this.state(secret);
    if (removed) await this.roles.audit({ actorAccountId: actor.accountId, action: "secrets.reset", target: key, before: auditOf(before), after: auditOf(after) });
    return await this.view(after);
  }

  /**
   * Проверка связи с сервисом. Без `candidate` — действующим ключом (право
   * смотреть); с ним — ещё не сохранённым из формы (право менять: ключ
   * приходит от человека, который собирается его записать).
   */
  async check(actor: AccountRef, key: string, candidate: string | null, fetchImpl: typeof fetch = fetch): Promise<SecretCheckResult> {
    await this.roles.require(actor, candidate === null ? "secrets.view" : "secrets.edit");
    const secret = this.definition(key);
    if (secret.check === undefined) throw new SecretUncheckableError();
    const value = candidate === null ? this.secrets.get(secret) : candidate.trim();
    if (value === null) throw new SecretMissingError();
    const problem = candidate === null ? null : secretProblem(secret, value);
    if (problem !== null) throw new ValidationError(problem);
    return await secret.check(value, fetchImpl);
  }

  private definition(key: string): SecretDefinition {
    const secret = secretByKey(key);
    if (secret === undefined) throw new SecretNotFoundError();
    return secret;
  }

  private state(secret: SecretDefinition): SecretState {
    const state = this.secrets.describe().find((item) => item.secret.key === secret.key);
    if (state === undefined) throw new SecretNotFoundError();
    return state;
  }

  private async view(state: SecretState): Promise<SecretView> {
    const names = state.updatedBy === null ? new Map<string, string>() : await this.accounts.displayNames([state.updatedBy]);
    return viewOf(state, names);
  }
}

function viewOf(state: SecretState, names: ReadonlyMap<string, string>): SecretView {
  const { secret } = state;
  return {
    key: secret.key,
    service: secret.service,
    title: secret.title,
    hint: secret.hint,
    cabinetUrl: secret.cabinetUrl,
    example: secret.example,
    pattern: secret.pattern.source,
    checkable: secret.check !== undefined,
    generated: secret.generated?.where ?? null,
    source: state.source,
    fingerprint: state.fingerprint,
    envSet: state.envSet,
    unreadable: state.unreadable,
    updatedBy: state.updatedBy,
    updatedByName: state.updatedBy === null ? null : (names.get(state.updatedBy) ?? null),
    updatedAt: state.updatedAt,
  };
}

/**
 * В журнал — название, откуда ключ и его последние знаки: «было из окружения
 * ••••a1f3, стало из панели ••••9c2e». Название — чтобы журнал читался без
 * каталога, когда ключ из него однажды уберут.
 */
function auditOf(state: SecretState): Record<string, unknown> {
  return { title: state.secret.title, source: state.source, fingerprint: state.fingerprint };
}
