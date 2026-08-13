// Run nightly via the hamstation-backup systemd timer (see deploy/).
import { runBackup } from '../src/backup';

const result = runBackup();
console.log(`Backup written to ${result.dir} (${(result.dbBytes / 1024 / 1024).toFixed(1)} MB database).`);
