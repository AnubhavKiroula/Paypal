import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { QUARANTINE_MODULE, typeSafetyGuards } from '../eslint/type-safety-guards.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Only the guards plus a TS parser: fast, and isolates exactly the selectors under test.
const guardsOnly = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...typeSafetyGuards],
});

async function violations(code: string, filePath = 'packages/llm/src/example.ts'): Promise<string[]> {
  const [result] = await guardsOnly.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

const header = "import type { Quarantined } from '@mandate/shared';\nimport * as shared from '@mandate/shared';\ndeclare const raw: string;\n";

describe('type-safety lint guards', () => {
  it.each([
    ['an `as Quarantined` cast', 'const q = raw as Quarantined<string>;'],
    ['an angle-bracket cast', 'const q = <Quarantined<string>>raw;'],
    ['a double cast through unknown', 'const q = raw as unknown as Quarantined<string>;'],
    ['a namespace-qualified cast', 'const q = raw as shared.Quarantined<string>;'],
    ['a cast to never', 'const q: Quarantined<string> = raw as never;'],
  ])('flags %s outside the quarantine module', async (_label, line) => {
    expect(await violations(header + line)).toEqual(['no-restricted-syntax']);
  });

  it('allows the quarantine module itself to cast to Quarantined', async () => {
    expect(await violations(`${header}const q = raw as Quarantined<string>;`, QUARANTINE_MODULE)).toEqual([]);
  });

  it('still flags a cast to never inside the quarantine module', async () => {
    expect(await violations(`${header}const q = raw as never;`, QUARANTINE_MODULE)).toEqual(['no-restricted-syntax']);
  });

  it('does not flag ordinary casts or calls', async () => {
    const code = `${header}declare function quarantineText(r: unknown): { text: Quarantined<string> };\nconst a = raw as string;\nconst b = quarantineText(raw).text;`;
    expect(await violations(code)).toEqual([]);
  });

  it('is wired into the repository ESLint config', async () => {
    const real = new ESLint({ cwd: ROOT });
    const selectors = async (file: string) => {
      const config = (await real.calculateConfigForFile(file)) as { rules?: Record<string, unknown[]> };
      return JSON.stringify(config.rules?.['no-restricted-syntax'] ?? []);
    };
    expect(await selectors('packages/llm/src/client.ts')).toContain('Quarantined');
    expect(await selectors('packages/llm/src/client.ts')).toContain('TSNeverKeyword');
    const quarantineModule = await selectors(QUARANTINE_MODULE);
    expect(quarantineModule).not.toContain('Quarantined');
    expect(quarantineModule).toContain('TSNeverKeyword');
  });
});
