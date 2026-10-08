/**
 * The provider catalog as the dashboard sees it. The data is `config/providers.catalog.json`, the one source of truth.
 * `npm run sync:providers` copies it to `lib/providers.catalog.json`, and the CI gate fails if the copy is stale.
 * No other file in the dashboard keeps its own list of providers.
 */
import catalogJson from "./providers.catalog.json";

export interface CatalogInput {
  required?: boolean;
  default?: string;
  help?: string;
}

export interface CatalogProvider {
  id: string;
  label: string;
  verifiable: boolean;
  unverifiableReason?: string;
  usedBy: string[];
  failover: "direct" | "custom" | null;
  note?: string;
  secrets: Record<string, string>;
  inputs: Record<string, CatalogInput>;
  keyHint: { prefixes: string[]; text: string };
  getKeyUrl: string;
  noCard: boolean;
  freeTierNote: { text: string; source: string; checkedOn: string };
}

export const PROVIDER_CATALOG = catalogJson.providers as unknown as CatalogProvider[];

/** Every id in the catalog, in failover order. */
export const PROVIDER_IDS: string[] = PROVIDER_CATALOG.map((p) => p.id);

export function catalogProvider(id: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/** The providers that the pulse reports on. A custom slot appears only after it has a record. */
export function pulseProviderIds(known: Record<string, unknown> | undefined): string[] {
  return PROVIDER_CATALOG.filter((p) => p.usedBy.includes("pulse") && (p.failover !== "custom" || Boolean(known?.[p.id]))).map((p) => p.id);
}
