// Usage: bun scripts/set-eqsl-credentials.ts <callsign> <password>
// Writes EQSL_USERNAME/EQSL_PASSWORD into ../.env -- same pattern as
// set-qrz-key.ts. Run this yourself in a terminal on the Pi, not through
// Claude Code, so the password never ends up in a chat transcript.
import path from 'node:path';

const [callsign, password] = process.argv.slice(2);
if (!callsign || !password) {
  console.error('Usage: bun scripts/set-eqsl-credentials.ts <callsign> <password>');
  process.exit(1);
}

const envPath = path.join(import.meta.dir, '..', '.env');
const existing = (await Bun.file(envPath).exists()) ? await Bun.file(envPath).text() : '';
const lines = existing.split('\n').filter((l) => l && !l.startsWith('EQSL_USERNAME=') && !l.startsWith('EQSL_PASSWORD='));
// Bun's .env loader expands bare `$name` tokens, so escape any literal `$` just in case.
lines.push(`EQSL_USERNAME=${callsign.toUpperCase().replaceAll('$', '\\$')}`);
lines.push(`EQSL_PASSWORD=${password.replaceAll('$', '\\$')}`);
await Bun.write(envPath, lines.join('\n') + '\n');
console.log('eQSL credentials set. (.env updated)');
