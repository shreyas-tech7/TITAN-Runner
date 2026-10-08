/**
 * @file The provider catalog loader (Wave 12, K1).
 *
 * `config/providers.catalog.json` is the one source of truth for model providers. This module reads it
 * once and gives the rest of the repo small helpers, so no other file keeps its own provider list. The
 * Worker bundles the same JSON file. `scripts/check-provider-catalog.mjs` checks that the Worker, the
 * workflows, and `.env.example` agree with it.
 */
import { readFileSync } from 'node:fs';

const CATALOG_URL = new URL('../../config/providers.catalog.json', import.meta.url);

/** @typedef {{ id: string, label: string, kind: string, verifiable: boolean, usedBy: string[], failover: 'direct'|'custom'|null, secrets: Record<string,string>, inputs: Record<string, object>, keyHint: { prefixes: string[], pattern?: string, text: string }, validate: object|null, chat: object|null, getKeyUrl: string, noCard: boolean, freeTierNote: { text: string, source: string, checkedOn: string }, unverifiableReason?: string, note?: string }} CatalogProvider */

/** @returns {{ schemaVersion: number, updated: string, providers: CatalogProvider[] }} */
export function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_URL, 'utf8'));
}

const catalog = loadCatalog();

/** @type {readonly CatalogProvider[]} */
export const PROVIDERS = Object.freeze(catalog.providers);

/** @param {string} id @returns {CatalogProvider|null} */
export function getCatalogProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The five direct adapters, in failover order. */
export const DIRECT_PROVIDER_IDS = Object.freeze(PROVIDERS.filter((p) => p.failover === 'direct').map((p) => p.id));

/** The generic OpenAI compatible providers. They come last in failover. */
export const CUSTOM_PROVIDER_IDS = Object.freeze(PROVIDERS.filter((p) => p.failover === 'custom').map((p) => p.id));

/** Every secret name in the catalog. */
export function allSecretNames() {
  return PROVIDERS.flatMap((p) => Object.values(p.secrets));
}

/** The environment variable that holds a provider's key. */
export function keyEnvName(id) {
  return getCatalogProvider(id)?.secrets.key ?? null;
}

/**
 * A soft check of a key against the catalog hint. It never blocks a save.
 * @param {string} id
 * @param {string} value
 * @returns {string|null} A warning text, or null when the key looks right or the provider has no hint.
 */
export function keyHintWarning(id, value) {
  const hint = getCatalogProvider(id)?.keyHint;
  if (!hint) return null;
  const prefixes = hint.prefixes ?? [];
  if (prefixes.length === 0 && !hint.pattern) return null;
  if (prefixes.some((p) => value.startsWith(p))) return null;
  if (hint.pattern && new RegExp(hint.pattern).test(value)) return null;
  return hint.text || 'This key does not look like the usual format.';
}

export default { PROVIDERS, DIRECT_PROVIDER_IDS, CUSTOM_PROVIDER_IDS, getCatalogProvider, allSecretNames, keyEnvName, keyHintWarning, loadCatalog };
