import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source must be ASCII-only. Invisible characters (bidi overrides, zero-width, tag characters)
// in code make reviewers read different text than the compiler does ("Trojan Source").
// Write \u escapes instead of literal characters.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIPPED_DIRS = new Set(['node_modules', 'coverage', 'dist', 'graphify-out', '.git']);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : listSourceFiles(join(dir, entry.name));
    }
    return SOURCE_FILE.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

export function linesWithNonAscii(text: string): number[] {
  return text.split('\n').flatMap((line, index) => ([...line].some((c) => (c.codePointAt(0) ?? 0) > 0x7f) ? [index + 1] : []));
}

describe('source hygiene', () => {
  it('detects a non-ASCII character such as a bidi override', () => {
    const rightToLeftOverride = String.fromCharCode(0x202e);
    expect(linesWithNonAscii(`ok\nif (isAdmin${rightToLeftOverride}) {}`)).toEqual([2]);
    expect(linesWithNonAscii('plain ascii\n')).toEqual([]);
  });

  it('keeps every TS/JS source file ASCII-only', () => {
    const files = listSourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.flatMap((file) =>
      linesWithNonAscii(readFileSync(file, 'utf8')).map((line) => `${relative(ROOT, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
