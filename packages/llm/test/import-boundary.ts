import { builtinModules } from 'node:module';
import { posix } from 'node:path';

/** Runtime dependencies @mandate/llm may declare (R11). */
export const ALLOWED_DEPENDENCIES = ['@anthropic-ai/sdk', '@mandate/shared', 'zod'] as const;

/** Never importable from the LLM layer: payment code, apps, the policy engine, the eval baselines. */
export const FORBIDDEN_SPECIFIERS: readonly RegExp[] = [
  /paypal/i,
  /(^|\/)apps\//,
  /(^|\/)packages\/(policy|evals)(\/|$)/,
  /^@mandate\/(policy|evals|api|web)(\/|$)/,
];

export interface SourceFile {
  /** POSIX path relative to the package root, e.g. "src/client.ts". */
  path: string;
  source: string;
}

export interface Violation {
  path: string;
  specifier: string;
  reason: string;
}

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function extractSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ''));
}

const BUILTINS = new Set(builtinModules);

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * Every import must be relative inside the package, a Node builtin, or an allowed dependency.
 * `extraAllowed` lets test-only code (smoke tests) import dev tools such as vitest; forbidden
 * specifiers stay forbidden regardless.
 */
export function findForbiddenImports(files: readonly SourceFile[], extraAllowed: readonly string[] = []): Violation[] {
  return files.flatMap(({ path, source }) =>
    extractSpecifiers(source).flatMap((specifier): Violation[] => {
      const forbidden = FORBIDDEN_SPECIFIERS.find((pattern) => pattern.test(specifier));
      if (forbidden) return [{ path, specifier, reason: `matches ${String(forbidden)}` }];
      if (specifier.startsWith('.')) {
        const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
        return resolved.startsWith('..') ? [{ path, specifier, reason: 'relative import escapes the package' }] : [];
      }
      if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return [];
      const allowed: readonly string[] = [...ALLOWED_DEPENDENCIES, ...extraAllowed];
      return allowed.includes(packageName(specifier)) ? [] : [{ path, specifier, reason: 'not an allowed dependency' }];
    }),
  );
}

/** Checks a package.json: runtime dependencies are allow-listed, and none look forbidden. */
export function findForbiddenDependencies(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (typeof deps !== 'object' || deps === null) {
      problems.push(`${field} is not an object`);
      continue;
    }
    for (const name of Object.keys(deps)) {
      const allowed: readonly string[] = ALLOWED_DEPENDENCIES;
      if (field !== 'dependencies' || !allowed.includes(name)) problems.push(`${field}: ${name}`);
    }
  }
  return problems;
}
