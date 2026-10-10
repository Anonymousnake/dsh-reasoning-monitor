import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { boot, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { stateHandler } from '../lib/settings.js';

const require = createRequire(import.meta.url);

test('real profile settings validate, persist and apply live without replacing the monitor', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reasoning-monitor-'));
  assert.ok(home.startsWith(join(tmpdir(), 'reasoning-monitor-')));
  const dir = join(home, 'profiles', 'web');
  await mkdir(dir, { recursive: true });
  const patchPath = join(dir, 'cordis.patch.yml');
  const configPath = join(dir, 'cordis.yml');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  await writeFile(configPath, '[]\n');
  const patches = [{ insert: [
    { id: 'config-editor', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-config-editor')).href },
    { id: 'settings', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-settings')).href },
    { id: 'reasoning-guard', name: new URL('../lib/index.js', import.meta.url).href,
      config: { perBlockLimit: 88, repeatedRunLimit: 44 } },
  ] }];
  await writeFile(patchPath, JSON.stringify(patches));
  const start = () => boot('monitor-test', configPath,
    loadProfileDirectory('monitor-test', dir, require.resolve('../package.json')).patches, ctx => {
    ctx.provide('profileContext', { name: 'fixture', dir, home, patchPath,
      installAnchor: require.resolve('../package.json'), cwd: home, startedBundles: [], overlays: [] });
    ctx.provide('agents', { list: () => [] });
    ctx.provide('tools', { register() {} });
  });
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(home, { recursive: true }); });
  ctx = await start();
  const settings = ctx.get('settings');
  const monitor = ctx.get('reasoningMonitor');
  assert.equal(monitor.getSnapshot().config.repeatedRunLimit, 44);
  assert.equal(monitor.getSnapshot().config.perBlockLimit, 88);
  const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'reasoning-guard');
  assert.equal(descriptor.autoGenerate, false, 'the custom page owns presentation');
  const revision = descriptor.revision;
  await settings.update('reasoning-guard', { enabled: false }, revision);
  assert.equal(monitor.getSnapshot().config.enabled, false);
  assert.equal(ctx.get('reasoningMonitor'), monitor, 'live saves must retain monitoring state');
  assert.equal(monitor.getSnapshot().config.repeatedRunLimit, 44);
  await assert.rejects(settings.update('reasoning-guard', { verbose: true }, revision), { code: 'SETTINGS_CONFLICT' });
  const persisted = await readFile(patchPath, 'utf8');
  await assert.rejects(settings.update('reasoning-guard', { repeatedRunLimit: -1 }));
  await assert.rejects(settings.update('reasoning-guard', { minChantRatio: 0 }));
  await assert.rejects(settings.update('reasoning-guard', { action: 'unknown' }));
  assert.equal(await readFile(patchPath, 'utf8'), persisted, 'invalid edits must not alter the profile');
  await settings.update('reasoning-guard', { enabled: true });
  assert.equal(monitor.getSnapshot().config.enabled, true);
  await settings.update('reasoning-guard', { enabled: false, repeatedRunLimit: 55 });
  await ctx.fiber.dispose();
  ctx = await start();
  assert.equal(ctx.get('reasoningMonitor').getSnapshot().config.enabled, false);
  assert.equal(ctx.get('reasoningMonitor').getSnapshot().config.repeatedRunLimit, 55);
});

test('status endpoint is read-only and restricted to local same-site requests', () => {
  const handler = stateHandler({ getSnapshot: () => ({ version: 1, agents: [] }) });
  function call(changes = {}) {
    const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }, ...changes };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
    handler(req, res); return res;
  }
  assert.equal(call().statusCode, 200);
  assert.equal(call().headers['cache-control'], 'no-store');
  assert.equal(call({ method: 'POST' }).statusCode, 405);
  assert.equal(call({ socket: { remoteAddress: '192.0.2.1' } }).statusCode, 403);
  assert.equal(call({ headers: { host: 'attacker.example:3080' } }).statusCode, 403);
  assert.equal(call({ headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' } }).statusCode, 403);
});
