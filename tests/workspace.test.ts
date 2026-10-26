import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRootJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
}

describe('workspace contract', () => {
  it('keeps the strict compiler flags every package relies on', () => {
    expect(readRootJson('tsconfig.base.json')).toMatchObject({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
      },
    });
  });

  it('pins pnpm and every root devDependency to an exact version', () => {
    const pkg = readRootJson('package.json');
    expect(pkg).toMatchObject({ packageManager: expect.stringMatching(/^pnpm@\d+\.\d+\.\d+$/) as unknown });

    const devDependencies = (pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {};
    expect(Object.keys(devDependencies).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(devDependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
