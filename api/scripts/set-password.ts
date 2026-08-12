// Usage: bun scripts/set-password.ts <new-password>
// Hashes the password and writes ADMIN_PASSWORD_HASH into ../.env
import path from 'node:path';

const password = process.argv[2];
if (!password) {
  console.error('Usage: bun scripts/set-password.ts <new-password>');
  process.exit(1);
}

const hash = await Bun.password.hash(password);
const envPath = path.join(import.meta.dir, '..', '.env');
const existing = (await Bun.file(envPath).exists()) ? await Bun.file(envPath).text() : '';
const lines = existing.split('\n').filter((l) => l && !l.startsWith('ADMIN_PASSWORD_HASH='));
// Bun's .env loader expands bare `$name` references, which would otherwise mangle
// an argon2 hash like `$argon2id$v=19$...` — escape every `$` to keep it literal.
const escapedHash = hash.replaceAll('$', '\\$');
lines.push(`ADMIN_PASSWORD_HASH=${escapedHash}`);
await Bun.write(envPath, lines.join('\n') + '\n');
console.log('Admin password set. (.env updated)');
