/**
 * @file Backward-compatibility re-exports for the file-envelope parser.
 *
 * `outputParser.js` is now the single implementation of the three-tier
 * parse (strict fenced envelope -> lenient local repair -> legacy
 * `// file:` convention -> optional tier-3 repair). This file previously
 * carried its own duplicate copies of `extractFileBlocks`, `normalizePath`,
 * and a two-tier `parseEnvelope`, which could (and did) drift from
 * `outputParser.js`. Those have been consolidated; this module keeps the old
 * public names working so existing importers (`synthesizer.js` and any
 * test) need no change:
 *
 *   - `parseEnvelope(text)` — synchronous tier 1/2 parse, same result shape.
 *   - `extractFileBlocks(text)` — the legacy `// file:` convention extractor.
 *   - `normalizePath(path)` — traversal-safe path normalisation.
 */
export { normalizePath, extractFileBlocks, parseEnvelope } from './outputParser.js';
