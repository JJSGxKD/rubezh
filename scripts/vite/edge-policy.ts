import type { Plugin } from "vite";

/**
 * Политика источников — файлом в сборку (docs/09-ci-cd.md §10, «Заголовки на
 * краю»). В проде заголовок ставит Caddy, и он обязан быть ровно тем, что
 * отдаёт `vite preview` и под чем проверен забег: своя строка в Caddyfile —
 * вторая копия, которая однажды разойдётся с проверенной. Поэтому сборка
 * кладёт политику в `csp.txt`, а выкат делает из неё сниппет Caddy
 * (`infra/prod/deploy.sh`).
 */
export const EDGE_POLICY_FILE = "csp.txt";

export function edgePolicyFile(policy: string): Plugin {
  return {
    name: "edge-policy-file",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: EDGE_POLICY_FILE, source: `${policy}\n` });
    },
  };
}
