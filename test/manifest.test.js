// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest shape is validated by the store indexer, but nothing there can
// know which handlers the code actually registers — these tests keep both in
// sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { CARBON_LEVELS, CARBON_LEVEL_DIRECTIONS } from '../src/carbonLevel.js';
import { SCENE_ACTIONS, SCENE_TRIGGERS, publishCarbonLevelEvent } from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';
import { rememberGridSnapshot } from '../src/gridSnapshot.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('every manifest action has a registered handler', () => {
  const handled = new Set(DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every stored config key is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue; // presentational block, stores no value
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config key "${field.key}" is missing from DEFAULT_CONFIG`,
    );
  }
});

test('the refresh interval bounds of the manifest match the clamping of the code', () => {
  const field = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.ok(field, 'the integration must let the user set its refresh interval');
  assert.equal(normalizeConfig({ poll_frequency: field.min - 1 }).poll_frequency, field.min);
  assert.equal(normalizeConfig({ poll_frequency: field.max + 1 }).poll_frequency, field.max);
});

test('the API token is declared as a secret field', () => {
  const field = manifest.config_schema.find((f) => f.key === 'api_token');
  assert.equal(field.type, 'secret', 'a token must never be sent back to the frontend');
  assert.equal(field.required, true);
  assert.equal(field.default, undefined, 'a secret field cannot carry a default');
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // Older cores reject any unknown manifest field, so a manifest declaring
  // `categories` must not claim compatibility below the first release that
  // accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the integration declares itself as cloud-only', () => {
  // Electricity Maps is a public HTTP API: there is no LAN path, so no
  // "Prefer the local connection" toggle and no GLADYS_PREFER_LOCAL key.
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.ok(!('GLADYS_PREFER_LOCAL' in DEFAULT_CONFIG));
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the onboarding hint lives in a section block');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the card texts respect the store limits', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${lang} must be 10-100 chars`);
  }
  assert.ok(manifest.description.en, 'the English description is mandatory');
});

test('the manifest version matches the docker image tag', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'strict semver');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the image tag and the manifest version must stay in lockstep',
  );
});

// --- Gladys 5.1 capabilities -------------------------------------------------
// Widgets, scene triggers and scene actions are declared in the manifest and
// implemented in the code: nothing but a test keeps the two lists together, and
// a declared key with no handler is a card that fails in front of the user.

test('declaring widgets and scene declarations requires Gladys >= 5.1.0', () => {
  // Same rule as `categories`: an older core rejects any unknown manifest
  // field, so the compatibility range has to move with the declarations.
  const [, major, minor] = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/).map(Number);
  assert.ok(
    major > 5 || (major === 5 && minor >= 1),
    `widgets and scene declarations require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every declared widget has a handler, and every handler is declared', () => {
  const declared = manifest.widgets.map((w) => w.key);
  assert.deepEqual(declared.sort(), Object.keys(WIDGETS).sort());
  for (const [key, widget] of Object.entries(WIDGETS)) {
    assert.equal(typeof widget.get, 'function', `widget "${key}" must resolve a content`);
    assert.equal(typeof widget.action, 'function', `widget "${key}" must handle its buttons`);
  }
});

test('every declared scene action has a handler, and every handler is declared', () => {
  const declared = manifest.scene_actions.map((a) => a.key);
  assert.deepEqual(declared.sort(), Object.keys(SCENE_ACTIONS).sort());
});

test('every trigger the code fires is declared in the manifest', () => {
  const declared = new Set(manifest.scene_triggers.map((t) => t.key));
  for (const key of Object.values(SCENE_TRIGGERS)) {
    assert.ok(declared.has(key), `the code fires "${key}", which no trigger declares (404)`);
  }
});

test('the widgets respect the store limits', () => {
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    for (const [lang, text] of Object.entries(widget.label)) {
      assert.ok(text.length >= 3 && text.length <= 30, `widgets.label.${lang} must be 3-30 chars`);
    }
    for (const [lang, text] of Object.entries(widget.description ?? {})) {
      assert.ok(text.length <= 100, `widgets.description.${lang} must be at most 100 chars`);
    }
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/, 'the icon is a Feather icon name');
    // The refresh button reads Electricity Maps live: two HTTP calls of 15 s
    // must fit in the ack the core waits for.
    assert.ok(widget.action_timeout_seconds >= 60, 'a live read needs room to answer');
  }
});

test('the scene declarations respect the store limits', () => {
  for (const [list, entries] of Object.entries({
    scene_triggers: manifest.scene_triggers,
    scene_actions: manifest.scene_actions,
  })) {
    assert.ok(entries.length >= 1 && entries.length <= 20, `${list} holds 1 to 20 entries`);
    for (const entry of entries) {
      assert.match(entry.key, /^[a-z0-9_]{1,40}$/, `${list} key`);
      assert.ok(entry.label.en, `${list} "${entry.key}" needs an English label`);
      assert.ok((entry.fields ?? []).length <= 10, `${list} "${entry.key}" holds 10 fields`);
      for (const field of entry.fields ?? []) {
        assert.match(field.key, /^[a-z0-9_]+$/);
        if (field.type === 'select' || field.type === 'multi_select') {
          assert.ok(field.options.length >= 1, `"${field.key}" needs options`);
        }
      }
    }
  }
});

test('a trigger filter is never a toggle', () => {
  // The core refuses a boolean trigger field: a toggle could not express
  // "any", which is what an untouched filter has to mean.
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields ?? []) {
      assert.notEqual(field.type, 'boolean', `${trigger.key}.${field.key}`);
    }
  }
});

test('the scene variables and outputs are scalars, at most 20 of them', () => {
  const lists = [
    ...manifest.scene_triggers.map((t) => [t.key, t.variables ?? []]),
    ...manifest.scene_actions.map((a) => [a.key, a.outputs ?? []]),
  ];
  for (const [key, entries] of lists) {
    assert.ok(entries.length <= 20, `"${key}" declares at most 20 entries`);
    for (const entry of entries) {
      assert.ok(['string', 'number', 'boolean'].includes(entry.type), `${key}.${entry.key}`);
      assert.ok(entry.label.en, `${key}.${entry.key} needs an English label`);
    }
  }
});

test('the levels of the trigger filter are the ones the code publishes', () => {
  const trigger = manifest.scene_triggers.find(
    (t) => t.key === SCENE_TRIGGERS.CARBON_LEVEL_CHANGED,
  );
  const declared = trigger.fields.find((f) => f.key === 'level').options.map((o) => o.value);
  assert.deepEqual(
    declared.sort(),
    Object.values(CARBON_LEVELS).sort(),
    'a filter the event can never match is a scene that never runs',
  );

  const directions = trigger.fields.find((f) => f.key === 'direction').options.map((o) => o.value);
  assert.deepEqual(directions.sort(), Object.values(CARBON_LEVEL_DIRECTIONS).sort());
});

test('the event the code fires only carries declared keys', async () => {
  const trigger = manifest.scene_triggers.find(
    (t) => t.key === SCENE_TRIGGERS.CARBON_LEVEL_CHANGED,
  );
  // The core matches on the `fields` and exposes the `variables`: any other key
  // of the event is silently dropped, which would be a value nobody can use.
  const known = new Set([
    ...trigger.fields.map((f) => f.key),
    ...trigger.variables.map((v) => v.key),
  ]);

  const gladys = createFakeGladys();
  const config = normalizeConfig({ api_token: 'test-token', zone: 'FR' });
  const values = { carbonFreePercentage: 92, renewablePercentage: 28 };
  rememberGridSnapshot(config, { carbonIntensity: 57, ...values });
  await publishCarbonLevelEvent(
    gladys,
    rememberGridSnapshot(config, { carbonIntensity: 450, ...values }),
  );

  assert.equal(gladys.sceneEvents.length, 1, 'the level change must fire');
  for (const key of Object.keys(gladys.sceneEvents[0].data)) {
    assert.ok(known.has(key), `the event carries "${key}", which the manifest never declares`);
  }
  // And the other way round: a declared variable absent from the event is null
  // in the scene, which is a promise not kept.
  for (const variable of trigger.variables) {
    assert.ok(variable.key in gladys.sceneEvents[0].data, `"${variable.key}" is never published`);
  }
});
