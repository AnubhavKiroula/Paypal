declare const quarantinedBrand: unique symbol;

/**
 * Text that has passed quarantineText(). Only that function may produce one;
 * a lint rule bans `as Quarantined` casts everywhere else.
 */
export type Quarantined<T extends string = string> = T & { readonly [quarantinedBrand]: true };

export interface QuarantineFlags {
  truncated: boolean;
  /** C0/C1/DEL controls and zero-width/format characters were removed. */
  strippedControl: boolean;
  strippedBidi: boolean;
  strippedTagChars: boolean;
  strippedHtml: boolean;
  /** Telemetry only. A lexical guess, never a security control: the text is not changed by it. */
  injectionHeuristic: boolean;
}

export interface QuarantineOptions {
  /** Maximum output length in Unicode code points, including the truncation marker. */
  maxCodePoints?: number;
}

export interface QuarantineResult {
  text: Quarantined<string>;
  flags: QuarantineFlags;
}

/** ASCII on purpose: U+2026 (\u2026) is not NFKC-stable, which would break idempotence. */
export const TRUNCATION_MARKER = ' [truncated]';
export const DEFAULT_MAX_CODE_POINTS = 2_000;
const MARKER_CODE_POINTS = [...TRUNCATION_MARKER].length;

const NEWLINE_EQUIVALENTS = /\r\n?|[\u2028\u2029]/gu;
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;
const ZERO_WIDTH_AND_FORMAT = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/gu;
const BIDI_CONTROLS = /[\u061C\u202A-\u202E\u2066-\u2069]/gu;
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;
// Best-effort HTML removal, NOT a security boundary: the angle-bracket replacement after it,
// and the fact that the LLM call has no tools, are what make untrusted text inert.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
const EXCESS_NEWLINES = /\n{3,}/g;
// Telemetry only. Trivially evaded; never gate behaviour on it.
const INJECTION_HEURISTIC =
  /\b(?:ignore|disregard|forget)\b.{0,40}\b(?:previous|prior|above|earlier)\b.{0,20}\b(?:instructions?|prompts?|rules?)\b|\bskip\b.{0,20}\bapprovals?\b|\b(?:system|developer)\s+prompt\b|\byou\s+are\s+now\b/i;

export function quarantineText(raw: unknown, opts: QuarantineOptions = {}): QuarantineResult {
  const maxCodePoints = resolveLimit(opts.maxCodePoints);
  const flags: QuarantineFlags = {
    truncated: false,
    strippedControl: false,
    strippedBidi: false,
    strippedTagChars: false,
    strippedHtml: false,
    injectionHeuristic: false,
  };
  const mark = (flag: keyof QuarantineFlags) => () => {
    flags[flag] = true;
  };

  // 1. Coerce, replacing lone surrogates with U+FFFD.
  let text = coerce(raw).toWellFormed();
  // 2. Normalize first, so compatibility forms (e.g. fullwidth \uFF1C) cannot dodge the steps below.
  text = text.normalize('NFKC');
  // 3. Strip after normalizing.
  text = text.replace(NEWLINE_EQUIVALENTS, '\n');
  text = strip(text, CONTROLS, mark('strippedControl'));
  text = strip(text, ZERO_WIDTH_AND_FORMAT, mark('strippedControl'));
  text = strip(text, BIDI_CONTROLS, mark('strippedBidi'));
  text = strip(text, TAG_CHARACTERS, mark('strippedTagChars'));
  // 4. Remove HTML comments and tags, keeping inner text.
  text = strip(text, HTML_COMMENT, mark('strippedHtml'));
  text = strip(text, HTML_TAG, mark('strippedHtml'));
  // 5. No raw angle brackets survive, so text cannot forge tag-style delimiters.
  text = text.replaceAll('<', '\u2039').replaceAll('>', '\u203A');
  // 6. Collapse and trim.
  text = text.replace(EXCESS_NEWLINES, '\n\n').trim();
  // Removals can bring a base character next to a combining mark; re-compose so a second pass
  // is a no-op. NFKC cannot reintroduce anything stripped above (exhaustive scan, docs/llm-layer.md).
  text = text.normalize('NFKC');

  flags.injectionHeuristic = INJECTION_HEURISTIC.test(text);
  // 7. Truncate by code points, marker included in the limit.
  text = truncate(text, maxCodePoints, mark('truncated'));

  return { text: text as Quarantined<string>, flags };
}

function resolveLimit(maxCodePoints: number | undefined): number {
  const limit = maxCodePoints ?? DEFAULT_MAX_CODE_POINTS;
  if (!Number.isSafeInteger(limit) || limit <= MARKER_CODE_POINTS) {
    throw new RangeError(`maxCodePoints must be an integer greater than ${MARKER_CODE_POINTS}`);
  }
  return limit;
}

function coerce(raw: unknown): string {
  switch (typeof raw) {
    case 'string':
      return raw;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(raw);
    case 'object':
      if (raw === null) return '';
      try {
        return JSON.stringify(raw) ?? '';
      } catch {
        // Cycles, BigInt values or throwing getters: treat as no usable text.
        return '';
      }
    default:
      return '';
  }
}

function strip(text: string, pattern: RegExp, onRemoved: () => void): string {
  const result = text.replace(pattern, '');
  if (result !== text) onRemoved();
  return result;
}

function truncate(text: string, maxCodePoints: number, onTruncated: () => void): string {
  const codePoints = [...text];
  if (codePoints.length <= maxCodePoints) return text;
  onTruncated();
  return codePoints.slice(0, maxCodePoints - MARKER_CODE_POINTS).join('') + TRUNCATION_MARKER;
}
