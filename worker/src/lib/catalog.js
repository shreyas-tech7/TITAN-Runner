/**
 * @file The provider catalog as the Worker sees it. The data is `config/providers.catalog.json`, the one source of
 * truth for providers (decision W12-D5). Wrangler bundles the JSON into the Worker at deploy time.
 */
import catalogJson from '../../../config/providers.catalog.json' with { type: 'json' };

export const CATALOG = catalogJson;
export const PROVIDERS = catalogJson.providers;

/** @param {string} id */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Map of every catalog secret name to its provider id and role. */
export const SECRET_INDEX = (() => {
  const map = new Map();
  for (const p of PROVIDERS) for (const [role, name] of Object.entries(p.secrets)) map.set(name, { provider: p.id, role });
  return map;
})();

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Find secrets in the repo whose name is one spelling slip away from a catalog key secret, such as GROK_API_KEY
 * for GROQ_API_KEY. Only key secrets (names that end in _API_KEY) are checked.
 * @param {string[]} names All secret names in the repo.
 * @returns {Array<{ found: string, suggest: string, provider: string }>}
 */
export function findMisnamedSecrets(names) {
  const keyNames = PROVIDERS.map((p) => ({ name: p.secrets.key, provider: p.id }));
  const out = [];
  for (const found of names) {
    if (SECRET_INDEX.has(found) || !found.endsWith('_API_KEY')) continue;
    if (/^(TITAN|GITHUB|CLOUDFLARE|GEV)_/.test(found)) continue;
    const best = keyNames.map((k) => ({ ...k, d: distance(found, k.name) })).sort((x, y) => x.d - y.d)[0];
    if (best && best.d <= 2 && !names.includes(best.name)) out.push({ found, suggest: best.name, provider: best.provider });
  }
  return out;
}

/** The part of a catalog entry that is safe to send to the dashboard. */
export function publicProvider(p) {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    verifiable: p.verifiable,
    unverifiableReason: p.unverifiableReason ?? null,
    usedBy: p.usedBy,
    failover: p.failover ?? null,
    note: p.note ?? null,
    inputs: p.inputs ?? {},
    secretNames: p.secrets,
    keyHint: p.keyHint?.text ?? '',
    getKeyUrl: p.getKeyUrl,
    noCard: Boolean(p.noCard),
    freeTierNote: p.freeTierNote,
    canChat: Boolean(p.chat) && p.usedBy.includes('chat'),
  };
}
