import { execFileSync } from 'node:child_process';
import { isQQOfflineTime } from '../src/quiet-hours.js';
if (process.argv.includes('--can-start')) process.exit(isQQOfflineTime() ? 1 : 0);
const action = isQQOfflineTime() ? 'stop' : 'start';
execFileSync('/usr/bin/systemctl', ['--user', action, 'napcat-qq.service'], { stdio: 'inherit' });
console.log(`QQ schedule: ${action} (Asia/Shanghai, offline 01:00–07:00)`);
