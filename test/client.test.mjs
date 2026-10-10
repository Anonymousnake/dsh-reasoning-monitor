import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { DEFAULT_CONFIG } from '../lib/chant.js';

for (const accepted of [false, true]) {
  test(`native configuration form ${accepted ? 'accepted' : 'rejected'} save reports the correct result`, async t => {
    let declaration, Settings;
    const writes = [], state = [], cleanup = [];
    const React = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useReducer: () => [0, () => {}],
      useEffect() {},
      useRef: value => ({ current: value }),
      useState: value => [value, next => state.push(next)],
      useSyncExternalStore: (_subscribe, get) => get(),
    };
    runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: value => { declaration = value; } } },
      document: { hidden: false, addEventListener() {}, removeEventListener() {} },
      setTimeout, clearTimeout, AbortController,
    });
    const plugin = declaration.factory(() => React);
    assert.ok(plugin.inject.includes('configForms'));
    const form = {
      subscribe() {},
      getSnapshot: () => ({ status: 'ready', writable: true, value: DEFAULT_CONFIG }),
      async set(field, value) { writes.push({ field, value }); return accepted; },
    };
    const slots = {
      inject: (_name, install) => install(),
      register: (spec, component) => { if (spec.name === 'settings.section') Settings = component; },
    };
    plugin.apply({
      get: name => name === 'slots' ? slots : undefined,
      configForms: { get: id => { assert.equal(id, 'reasoning-guard'); return form; } },
      effect: install => cleanup.push(install()),
    });
    t.after(() => cleanup.forEach(dispose => dispose?.()));
    const elements = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      elements.push(node); node.children?.forEach(visit);
    }
    visit(Settings());
    const enabled = elements.find(node => node.type === 'input' && node.props.type === 'checkbox');
    assert.ok(enabled);
    assert.equal(await enabled.props.onChange({ target: { checked: false } }), accepted);
    assert.deepEqual(writes, [{ field: 'enabled', value: false }]);
    assert.equal(state.includes(true), true, 'saving state is observable');
    assert.equal(state.includes('保存失败'), !accepted, 'a false result must not show success');
    assert.equal(state.filter(value => value === true).length, accepted ? 2 : 1);
  });
}
