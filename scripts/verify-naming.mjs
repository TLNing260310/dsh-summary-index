import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../src/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const naming = JSON.parse(await readFile(join(ROOT, 'dsh-plugin.naming.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');

assert.equal(naming.schemaVersion, 1);
assert.equal(naming.registryOwner, 'local');
assert.equal(naming.packageName, pkg.name);
assert.equal(naming.pluginName, plugin.name);
assert.equal(naming.loaderId, 'dsh-summary-index');
assert.equal(naming.version, pkg.version);
assert.equal(plugin.PLUGIN_VERSION, pkg.version);
assert.match(naming.toolPrefix, /^[a-z][a-z0-9_]*_$/);
assert.equal(naming.configSchema, 'exported Schemastery Config');
assert.deepEqual([...naming.configKeys].sort(), Object.keys(plugin.Config.dict).sort());
assert.deepEqual([...naming.activation.exports].sort(), ['Config', 'apply', 'inject', 'name']);
assert.deepEqual(naming.activation.requiresServices, ['tools']);
assert.equal(naming.activation.registersCompactionService, false);
assert.equal(naming.permissions.writesSessionLogDirectly, false);
assert.equal(naming.permissions.canDisableModelVisibleInjection, true);
assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery']);
assert.ok(pkg.peerDependenciesMeta['@deepseek-ai/schemastery'].optional === true);
assert.equal(naming.httpRoutes.length, 0);
assert.equal(naming.compactionService.registers, false);
assert.equal(naming.compactionService.replacesBackend, false);
assert.match(patch, /name:\s*'dsh-summary-index'/);
assert.doesNotMatch(patch, /name:\s*'[^']*compaction[^']*'/i);
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

const registered = [];
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool.name);
      return () => {};
    },
  },
  on() {
    return () => {};
  },
  logger: { warn() {}, debug() {} },
};
plugin.apply(ctx, { indexRoot: join(ROOT, '.test-tmp', 'verify-naming') });
registered.sort();
const declared = naming.tools.map((tool) => tool.name).sort();
assert.deepEqual(registered, declared);
for (const name of registered) {
  assert.ok(name.startsWith(naming.toolPrefix), `${name} must use the declared tool prefix`);
  assert.equal(name.includes('.'), false);
  assert.equal(name.includes('/'), false);
}
assert.deepEqual([...new Set(registered)], registered);
await rm(join(ROOT, '.test-tmp', 'verify-naming'), { recursive: true, force: true });
console.log(`naming verified: ${registered.join(', ')}`);
