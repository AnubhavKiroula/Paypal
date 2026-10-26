// Lint guards for the untrusted-text type. Shared by eslint.config.js and tests/lint-guards.test.ts,
// so the test exercises exactly the selectors the repository enforces.

export const QUARANTINE_MODULE = 'packages/shared/src/quarantine.ts';

const QUARANTINED_MESSAGE = 'Only quarantineText() may create Quarantined text; do not cast to it.';
const NEVER_MESSAGE = 'Casting to never defeats the type system (it can launder untrusted text). Narrow instead.';

const QUARANTINED_CASTS = [
  { selector: "TSAsExpression[typeAnnotation.typeName.name='Quarantined']", message: QUARANTINED_MESSAGE },
  { selector: "TSAsExpression[typeAnnotation.typeName.right.name='Quarantined']", message: QUARANTINED_MESSAGE },
  { selector: "TSTypeAssertion[typeAnnotation.typeName.name='Quarantined']", message: QUARANTINED_MESSAGE },
  { selector: "TSTypeAssertion[typeAnnotation.typeName.right.name='Quarantined']", message: QUARANTINED_MESSAGE },
];

const NEVER_CASTS = [
  { selector: 'TSAsExpression > TSNeverKeyword', message: NEVER_MESSAGE },
  { selector: 'TSTypeAssertion > TSNeverKeyword', message: NEVER_MESSAGE },
];

// The second block replaces the rule options for the quarantine module, which alone may cast.
export const typeSafetyGuards = [
  { files: ['**/*.ts'], rules: { 'no-restricted-syntax': ['error', ...QUARANTINED_CASTS, ...NEVER_CASTS] } },
  { files: [QUARANTINE_MODULE], rules: { 'no-restricted-syntax': ['error', ...NEVER_CASTS] } },
];
