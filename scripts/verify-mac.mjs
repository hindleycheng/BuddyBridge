import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const directory = mkdtempSync(path.join(os.tmpdir(), 'buddybridge-verify-'));
try {
  execFileSync('ditto', ['-x', '-k', `release/BuddyBridge-${version}-mac-arm64.zip`, directory], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(directory, 'BuddyBridge.app')], { stdio: 'inherit' });
  console.log('Mac ZIP signature integrity verified (ad-hoc; not notarized).');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
