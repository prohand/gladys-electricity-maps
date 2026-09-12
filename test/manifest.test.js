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
