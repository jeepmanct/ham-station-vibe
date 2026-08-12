// Usage: bun scripts/set-qrz-key.ts <your-qrz-api-key>
// Writes QRZ_API_KEY into ../.env
import path from 'node:path';

const key = process.argv[2];
if (!key) {
  console.error('Usage: bun scripts/set-qrz-key.ts <your-qrz-api-key>');
  process.exit(1);
}

const envPath = path.join(import.meta.dir, '..', '.env');
const existing = (await Bun.file(envPath).exists()) ? await Bun.file(envPath).text() : '';
const lines = existing.split('\n').filter((l) => l && !l.startsWith('QRZ_API_KEY='));
// Bun's .env loader expands bare `$name` tokens, so escape any literal `$` just in case.
lines.push(`QRZ_API_KEY=${key.replaceAll('$', '\\$')}`);
await Bun.write(envPath, lines.join('\n') + '\n');
console.log('QRZ API key set. (.env updated)');
