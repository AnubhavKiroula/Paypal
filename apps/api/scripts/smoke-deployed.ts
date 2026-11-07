import { formatChecks, runSmoke } from '../src/smoke/deployed.js';

// Usage: pnpm smoke:deployed <apiUrl> [--web <webUrl>] [--purchase]
// Reads no environment and no credentials: it only calls the public API.

const args = process.argv.slice(2);
const apiUrl = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--web');
const webIndex = args.indexOf('--web');
const webOrigin = webIndex === -1 ? undefined : args[webIndex + 1];

if (!apiUrl || (webIndex !== -1 && !webOrigin)) {
  console.error('Usage: pnpm smoke:deployed <apiUrl> [--web <webUrl>] [--purchase]');
  process.exit(2);
}

const checks = await runSmoke({ apiUrl, ...(webOrigin ? { webOrigin } : {}), purchase: args.includes('--purchase') });
console.log(formatChecks(checks));
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
