import test from 'node:test';
import assert from 'node:assert/strict';
import { isQQOfflineTime } from '../src/quiet-hours.js';
test('QQ offline window uses Shanghai time and exact 01:00/07:00 boundaries', () => {
  for (const [time, expected] of [
    ['2026-10-25T00:59:59+08:00', false],
    ['2026-10-25T01:00:00+08:00', true],
    ['2026-10-25T06:59:59+08:00', true],
    ['2026-10-25T07:00:00+08:00', false],
    ['2026-10-25T23:59:59+08:00', false],
    ['2026-10-24T17:00:00Z', true],
  ]) assert.equal(isQQOfflineTime(new Date(time)), expected, time);
});

test('scheduled offline suppresses both text and file HTTP requests', async t => {
  const { configFromEnv, sendReply, sendOutputFile } = await import('../src/server.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T02:00:00+08:00') });
  const config = configFromEnv({ QQ_NIGHT_OFFLINE: '1', SEND_INTERVAL_MS: '1' });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not send while offline'); });
  assert.equal(await sendReply(config, '123', 'test'), false);
  assert.equal(await sendOutputFile({...config}, '123', {path:'/tmp/file.txt',wireName:'file.txt'}), false);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});
