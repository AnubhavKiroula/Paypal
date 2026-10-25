import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractSpecifiers, findForbiddenDependencies, findForbiddenImports } from './import-boundary.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** @mandate/shared is a runtime dependency, so a path to payments through it would count too. */
const SHARED_ROOT = fileURLToPath(new URL('../../shared', import.meta.url));

function readSources(dir: string, root = PACKAGE_ROOT): { path: string; source: string }[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, dir, entry.name);
    if (entry.isDirectory()) return readSources(relative(root, full), root);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ path: relative(root, full).split(sep).join('/'), source: readFileSync(full, 'utf8') }];
  });
}

describe('import boundary checker (fixtures)', () => {
  it('extracts every import form', () => {
    const source = [
      "import a from 'static';",
      "import type { B } from 'types-only';",
      "export * from 'reexport';",
      "import 'side-effect';",
      "const c = await import('dynamic');",
      "const d = require('commonjs');",
    ].join('\n');
    expect(extractSpecifiers(source).sort()).toEqual(
      ['commonjs', 'dynamic', 'reexport', 'side-effect', 'static', 'types-only'].sort(),
    );
  });

  it.each([
    ['a PayPal SDK', "import { Orders } from '@paypal/paypal-server-sdk';"],
    ['an unscoped PayPal package', "const pp = require('paypal-rest-sdk');"],
    ['the payments app by relative path', "const p = await import('../../../apps/api/src/payments.js');"],
    ['the policy engine by path', "export * from 'packages/policy';"],
    ['the policy engine by name', "import { evaluate } from '@mandate/policy';"],
    ['the eval baselines', "import { naiveAgent } from '@mandate/evals';"],
    ['a relative import escaping the package', "import { x } from '../../shared/src/money.js';"],
    ['an unlisted dependency', "import axios from 'axios';"],
  ])('flags %s', (_label, source) => {
    expect(findForbiddenImports([{ path: 'src/example.ts', source }])).toHaveLength(1);
  });

  it('accepts relative, builtin and allow-listed imports', () => {
    const source = [
      "import { z } from 'zod';",
      "import Anthropic from '@anthropic-ai/sdk';",
      "import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';",
      "import type { Quarantined } from '@mandate/shared';",
      "import { createHash } from 'node:crypto';",
      "import { LlmError } from '../errors.js';",
    ].join('\n');
    expect(findForbiddenImports([{ path: 'src/adapters/example.ts', source }])).toEqual([]);
  });

  it('allows a dev tool only where explicitly exempted, and never a forbidden specifier', () => {
    const runner = [{ path: 'smoke/x.smoke.test.ts', source: "import { it } from 'vitest';" }];
    expect(findForbiddenImports(runner)).toHaveLength(1);
    expect(findForbiddenImports(runner, ['vitest'])).toEqual([]);
    const payment = [{ path: 'smoke/x.smoke.test.ts', source: "import pp from '@paypal/checkout';" }];
    expect(findForbiddenImports(payment, ['@paypal/checkout'])).toHaveLength(1);
  });

  it('flags forbidden or unlisted manifest dependencies', () => {
    expect(findForbiddenDependencies({ dependencies: { zod: '1', '@paypal/agent-toolkit': '1' } })).toEqual([
      'dependencies: @paypal/agent-toolkit',
    ]);
    expect(findForbiddenDependencies({ peerDependencies: { zod: '1' } })).toEqual(['peerDependencies: zod']);
    expect(findForbiddenDependencies({ dependencies: 'zod' })).toEqual(['dependencies is not an object']);
  });
});

describe('@mandate/llm boundary (the real package)', () => {
  it('declares only allow-listed runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(findForbiddenDependencies(manifest)).toEqual([]);
  });

  it('imports nothing outside the allow-list from production code', () => {
    const files = readSources('src');
    expect(files.length).toBeGreaterThan(5);
    expect(findForbiddenImports(files)).toEqual([]);
  });

  it('reaches nothing forbidden through @mandate/shared, its only workspace dependency', () => {
    const manifest = JSON.parse(readFileSync(join(SHARED_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['name']).toBe('@mandate/shared');
    expect(findForbiddenDependencies(manifest)).toEqual([]);
    const files = readSources('src', SHARED_ROOT);
    expect(files.map((file) => file.path)).toContain('src/money.ts');
    expect(findForbiddenImports(files)).toEqual([]);
  });

  it('imports nothing forbidden from smoke code, which may also use the test runner', () => {
    const files = readSources('smoke');
    expect(files.length).toBeGreaterThan(1);
    expect(findForbiddenImports(files, ['vitest'])).toEqual([]);
  });
});
