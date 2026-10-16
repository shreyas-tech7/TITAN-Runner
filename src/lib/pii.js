/**
 * @file Personal data patterns for the public repository (overnight wave, rule 0.7).
 *
 * This repository is public. A secret pattern list already exists in `redact.js`. This file adds the
 * patterns for personal data that is not a credential: phone numbers, a Telegram user or chat id,
 * a US social security number, and a card number. The scanner prints the rule name and the place.
 * It never prints the matched text.
 */

/**
 * Luhn check for a run of digits. A real card number passes. A random long number mostly does not.
 * @param {string} digits
 */
export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Each rule has an id, a pattern with the global flag, and an optional `accept` check on the match.
 * @type {Array<{ id: string, pattern: RegExp, accept?: (match: string) => boolean }>}
 */
export const PII_RULES = [
  {
    id: 'phone-number',
    pattern: /(?<![\d.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
  },
  {
    id: 'telegram-user-id',
    pattern: /\b(?:telegram|tg)[_\s-]?(?:user[_\s-]?|owner[_\s-]?)?(?:id|chat[_\s-]?id)["']?\s*[:=]\s*["']?-?\d{5,}/gi,
  },
  {
    id: 'telegram-chat-id',
    pattern: /\bchat_id["']?\s*[:=]\s*["']?-?\d{6,}/gi,
  },
  {
    id: 'us-ssn',
    pattern: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g,
  },
  {
    id: 'card-number',
    pattern: /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g,
    accept: (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
];

/**
 * Find personal data in text.
 * @param {string} text
 * @returns {Array<{ rule: string, line: number }>} The rule id and the 1-based line. Never the text.
 */
export function findPii(text) {
  /** @type {Array<{ rule: string, line: number }>} */
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  for (const rule of PII_RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      if (rule.accept && !rule.accept(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ rule: rule.id, line });
    }
  }
  return out;
}
