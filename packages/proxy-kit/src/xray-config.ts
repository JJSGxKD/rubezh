import type { NodeSecurity, NodeTransport, ProxyNode } from "./node.js";

/**
 * Имена полей конфига Xray — одной таблицей: формат сверяется с образом
 * Xray (`xray run -test`) там, где контейнер собирается, и править при
 * расхождении нужно в одном месте.
 */
const F = {
  tagIn: (slot: number): string => `in-${slot}`,
  block: "block",
  inbounds: "inbounds",
  outbounds: "outbounds",
  routing: "routing",
  socks: "socks",
  blackhole: "blackhole",
  mux: "mux",
  stream: "streamSettings",
  tls: "tlsSettings",
  reality: "realitySettings",
  ws: "wsSettings",
  grpc: "grpcSettings",
  httpupgrade: "httpupgradeSettings",
  xhttp: "xhttpSettings",
} as const;

export interface XrayConfigOptions {
  basePort: number;
  slotCount: number;
  listen: string;
}

/** Ключ подписки (группы узлов): строчные латиница и цифры. Он входит в тег выхода, поэтому формат жёсткий. */
export const GROUP_FORMAT = /^[a-z0-9]{1,16}$/;

/** Узел в конфиге: из какой подписки (`group`), сам узел и его вход Xray. */
export interface PlacedNode {
  group: string;
  node: ProxyNode;
  slot: number;
}

/**
 * Тег выхода — с ключом подписки: один и тот же узел может прийти из двух
 * подписок, и ключ узла сам по себе уникален только внутри подписки.
 */
export const outboundTag = (group: string, key: string): string => `out-${group}-${key}`;

export interface SlotOptions {
  /** сколько всего входов у спутника */
  slotCount: number;
  /** слоты узлов других подписок: их не брать */
  reserved: ReadonlySet<number>;
  /** сколько слотов может занять эта подписка (её доля) */
  limit: number;
}

/**
 * Слоты узлов одной подписки. Прежние слоты сохраняются (порт узла не прыгает
 * между обновлениями подписки), если они свободны от чужих и доля ещё не
 * выбрана; новые узлы берут наименьшие свободные по порядку списка, а
 * не поместившиеся (нет свободных слотов или выбрана доля) — в `overflow`.
 */
export function assignSlots(keys: readonly string[], previous: ReadonlyMap<string, number>, options: SlotOptions): { slots: Map<string, number>; overflow: string[] } {
  const { slotCount, reserved } = options;
  const limit = Math.max(0, options.limit);
  const unique = [...new Set(keys)];
  const slots = new Map<string, number>();
  const used = new Set(reserved);
  const pending: string[] = [];

  for (const key of unique) {
    const slot = previous.get(key);
    if (slots.size < limit && slot !== undefined && Number.isInteger(slot) && slot >= 0 && slot < slotCount && !used.has(slot)) {
      slots.set(key, slot);
      used.add(slot);
    } else {
      pending.push(key);
    }
  }

  const overflow: string[] = [];
  let free = 0;
  for (const key of pending) {
    if (slots.size >= limit) {
      overflow.push(key);
      continue;
    }
    while (free < slotCount && used.has(free)) free++;
    if (free >= slotCount) {
      overflow.push(key);
      continue;
    }
    slots.set(key, free);
    used.add(free);
  }
  return { slots, overflow };
}

/**
 * Конфиг Xray спутника: по локальному SOCKS-входу на узел, без TUN. Порт входа —
 * `basePort + слот`. Узлы всех подписок идут одним конфигом.
 *
 * Выход `block` идёт первым: это выход по умолчанию Xray, и всё, что не
 * попало в правила, упирается в него, а не уходит напрямую.
 *
 * Конфиг с общим слотом у двух узлов или с ключом подписки не по формату не
 * собирается: два входа на одном порту или тег с мусором Xray принял бы молча.
 */
export function buildXrayConfig(nodes: readonly PlacedNode[], options: XrayConfigOptions): Record<string, unknown> {
  const slots = new Set<number>();
  const tags = new Set<string>();
  for (const { group, node, slot } of nodes) {
    if (!GROUP_FORMAT.test(group)) throw new RangeError(`Ключ подписки «${group}» не по формату ${String(GROUP_FORMAT)}`);
    if (!Number.isInteger(slot) || slot < 0 || slot >= options.slotCount) {
      throw new RangeError(`Слот ${slot} вне диапазона 0…${options.slotCount - 1}`);
    }
    if (slots.has(slot)) throw new RangeError(`Слот ${slot} занят дважды`);
    slots.add(slot);
    const tag = outboundTag(group, node.key);
    if (tags.has(tag)) throw new RangeError(`Выход ${tag} задан дважды`);
    tags.add(tag);
  }

  const placed = [...nodes].sort((a, b) => a.slot - b.slot);
  return {
    log: { loglevel: "warning", access: "none" },
    [F.inbounds]: placed.map(({ slot }) => ({
      tag: F.tagIn(slot),
      listen: options.listen,
      port: options.basePort + slot,
      protocol: F.socks,
      settings: { auth: "noauth", udp: false },
    })),
    [F.outbounds]: [{ tag: F.block, protocol: F.blackhole }, ...placed.map(({ group, node }) => outbound(group, node))],
    [F.routing]: {
      domainStrategy: "AsIs",
      rules: placed.map(({ group, node, slot }) => ({ type: "field", inboundTag: [F.tagIn(slot)], outboundTag: outboundTag(group, node.key) })),
    },
  };
}

function outbound(group: string, node: ProxyNode): Record<string, unknown> {
  return { tag: outboundTag(group, node.key), protocol: node.protocol, settings: settingsOf(node), [F.stream]: streamOf(node.transport, node.security), [F.mux]: { enabled: false } };
}

function settingsOf(node: ProxyNode): Record<string, unknown> {
  const { host: address, port, secret } = node;
  switch (node.protocol) {
    case "vless":
      return { vnext: [{ address, port, users: [{ id: secret, encryption: "none", ...(node.flow === null ? {} : { flow: node.flow }) }] }] };
    case "vmess":
      return { vnext: [{ address, port, users: [{ id: secret, alterId: 0, security: node.cipher ?? "auto" }] }] };
    case "trojan":
      return { servers: [{ address, port, password: secret }] };
    case "shadowsocks":
      return { servers: [{ address, port, method: node.cipher ?? "", password: secret }] };
  }
}

function streamOf(transport: NodeTransport, security: NodeSecurity): Record<string, unknown> {
  const stream: Record<string, unknown> = { network: transport.network, security: security.kind };

  if (security.kind === "tls") {
    stream[F.tls] = { serverName: security.serverName, ...(security.alpn.length > 0 ? { alpn: security.alpn } : {}), ...(security.fingerprint === null ? {} : { fingerprint: security.fingerprint }) };
  } else if (security.kind === "reality") {
    stream[F.reality] = { serverName: security.serverName, fingerprint: security.fingerprint, publicKey: security.publicKey, shortId: security.shortId, spiderX: security.spiderX };
  }

  const present = (entries: Record<string, string | undefined>): Record<string, string> =>
    Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined));

  switch (transport.network) {
    case "ws": {
      const settings = { ...present({ path: transport.path }), ...(transport.host === undefined ? {} : { headers: { Host: transport.host } }) };
      if (Object.keys(settings).length > 0) stream[F.ws] = settings;
      break;
    }
    case "grpc":
      stream[F.grpc] = { serviceName: transport.serviceName ?? "", multiMode: transport.mode === "multi" };
      break;
    case "httpupgrade": {
      const settings = present({ path: transport.path, host: transport.host });
      if (Object.keys(settings).length > 0) stream[F.httpupgrade] = settings;
      break;
    }
    case "xhttp": {
      const settings = present({ path: transport.path, host: transport.host, mode: transport.mode });
      if (Object.keys(settings).length > 0) stream[F.xhttp] = settings;
      break;
    }
    case "tcp":
      break;
  }
  return stream;
}
