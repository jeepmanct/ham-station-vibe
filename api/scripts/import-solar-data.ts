// Usage: bun scripts/import-solar-data.ts
// One-time (or re-run anytime) historical solar/geomagnetic data import.
import { fetchGfzSolarData, parseGfzSolarData, importSolarRecords } from '../src/solarData';

const text = await fetchGfzSolarData(true); // full history, not just the recent tail
const records = parseGfzSolarData(text);
const imported = importSolarRecords(records);
console.log(`Imported ${imported} days of solar data (${records[0]?.date} through ${records[records.length - 1]?.date}).`);
