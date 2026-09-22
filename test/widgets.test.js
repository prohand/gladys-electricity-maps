// -----------------------------------------------------------------------------
// Dashboard widget content.
//
// The core never refuses a content: it DROPS what it does not accept, silently.
// A widget that ships is therefore a widget whose content the core keeps as
// sent — which the SDK exports a checker for (`validateWidgetContent`), run
// here on every state the card can be in. An empty array means "rendered
// exactly as sent".
// -----------------------------------------------------------------------------

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGETS, WIDGET_KEYS } from '../src/widgets.js';
import { rememberGridSnapshot, resetGridSnapshot } from '../src/gridSnapshot.js';
import { gridCarbon } from '../src/devices/gridCarbon.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig({ api_token: 'test-token', zone: 'FR' });
const widget = WIDGETS[WIDGET_KEYS.GRID_CARBON];

// Until a probe or a poll has settled it, the plan is ASSUMED to serve the
// power breakdown: the device advertises the renewable sensor, so the card
// binds a tile to it. The last test settles it the other way, which is why it
// comes last — the answer is remembered for the process lifetime.
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetGridSnapshot();
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A fake Gladys where the user did (or did not) create the device. */
function gladysWith({ deviceCreated }) {
  const gladys = createFakeGladys();
  if (deviceCreated) {
    gladys.devices.push({ external_id: gridCarbon.deviceExternalId(gladys, config) });
  }
  return gladys;
}

function read(values = {}) {
  return rememberGridSnapshot(config, {
    carbonIntensity: 57,
    carbonFreePercentage: 92,
    renewablePercentage: null,
    ...values,
  });
}

const typesOf = (content) => content.components.map((component) => component.type);

test('every state of the card is a content the core keeps as sent', async () => {
  const cases = {
    'not configured': [normalizeConfig({ api_token: '', zone: 'FR' }), false, false],
    'no reading yet': [config, false, false],
    'device not created': [config, true, false],
    'device created': [config, true, true],
  };
  for (const [name, [widgetConfig, hasReading, deviceCreated]] of Object.entries(cases)) {
    resetGridSnapshot();
    if (hasReading) {
      read();
    }
    const gladys = gladysWith({ deviceCreated });
    const content = await widget.get(gladys, { config: widgetConfig });
    assert.deepEqual(validateWidgetContent(content), [], `content of the "${name}" card`);
  }
});

test('an empty configuration says what to do, and offers nothing else', async () => {
  const gladys = gladysWith({ deviceCreated: false });
  const content = await widget.get(gladys, {
    config: normalizeConfig({ api_token: '', zone: 'FR' }),
  });
  assert.deepEqual(typesOf(content), ['text']);
  assert.match(content.components[0].text.fr, /token/i);
});

test('the card binds to the device features once the device exists', async () => {
  read();
  const gladys = gladysWith({ deviceCreated: true });
  const content = await widget.get(gladys, { config });
  const features = gridCarbon.featureExternalIds(gladys, config);

  const tiles = content.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.device_feature),
    [features.carbonIntensity, features.carbonFree, features.renewable],
    'the tiles follow the published states instead of the content TTL',
  );
  for (const tile of tiles) {
    assert.equal(tile.value, undefined, 'a device-bound tile carries no value of its own');
  }

  const chart = content.components.find((component) => component.type === 'chart');
  assert.deepEqual(chart.device_features, [features.carbonIntensity]);
  assert.equal(chart.interval, 'last-day', 'the history Gladys already keeps');
  assert.equal(chart.series, undefined, 'never re-send points the core has');
});

test('without the device, the figures are still shown, and the chart is not', async () => {
  read({ renewablePercentage: 28 });
  const gladys = gladysWith({ deviceCreated: false });
  const content = await widget.get(gladys, { config });

  const tiles = content.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.value),
    [57, 92, 28],
  );
  for (const tile of tiles) {
    assert.equal(
      tile.device_feature,
      undefined,
      'nothing may point at a device that does not exist',
    );
  }
  assert.ok(!typesOf(content).includes('chart'), 'no device, no history to chart');
  assert.ok(
    content.components.some((component) => component.type === 'text'),
    'the card says where the live tiles and the chart come from',
  );
});

test('a value the API did not serve leaves no tile behind', async () => {
  read({ carbonFreePercentage: null });
  const gladys = gladysWith({ deviceCreated: false });
  const content = await widget.get(gladys, { config });
  const tiles = content.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.value),
    [57],
    'an empty tile is worse than no tile',
  );
});

test('the tiles are coloured by what they read, live or static', async () => {
  read({ carbonIntensity: 480, carbonFreePercentage: 22, renewablePercentage: 55 });
  for (const deviceCreated of [true, false]) {
    const gladys = gladysWith({ deviceCreated });
    const content = await widget.get(gladys, { config });
    const tiles = content.components.filter((component) => component.type === 'value');
    assert.deepEqual(
      tiles.map((tile) => tile.color),
      ['danger', 'danger', 'warning'],
      `a dirty grid reads as such on the ${deviceCreated ? 'live' : 'static'} card`,
    );
  }
});

test('a clean grid colours its tiles green', async () => {
  read({ renewablePercentage: 80 });
  const gladys = gladysWith({ deviceCreated: true });
  const content = await widget.get(gladys, { config });
  const tiles = content.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.color),
    ['success', 'success', 'success'],
  );
});

test('the status row carries what no device feature holds', async () => {
  read();
  const gladys = gladysWith({ deviceCreated: true });
  const content = await widget.get(gladys, { config });
  const status = content.components.find((component) => component.type === 'status');
  const values = status.items.map((item) => item.value);
  assert.equal(values[0], 'FR', 'the zone');
  assert.equal(values[1].en, 'Very low', 'the carbon level');
  assert.equal(values[2].en, 'just now', 'the freshness of the reading');
});

test('the card is re-pulled at the pace of the refresh loop', async () => {
  read();
  const gladys = gladysWith({ deviceCreated: true });
  const slow = normalizeConfig({ api_token: 't', zone: 'FR', poll_frequency: 86400 });
  assert.equal((await widget.get(gladys, { config })).ttl_seconds, config.poll_frequency);
  assert.equal(
    (await widget.get(gladys, { config: slow })).ttl_seconds,
    3600,
    'the core clamps it to an hour anyway',
  );
});

test('the map button deep-links the followed zone over https', async () => {
  read();
  const gladys = gladysWith({ deviceCreated: true });
  const content = await widget.get(gladys, { config });
  const link = content.components.find((component) => component.link);
  assert.match(link.link.url, /^https:\/\/app\.electricitymaps\.com\/zone\/FR$/);
});

test('the refresh button reads the API and reports what it found', async () => {
  const gladys = gladysWith({ deviceCreated: true });
  let refreshed = false;
  const toast = await widget.action(gladys, {
    actionKey: 'refresh',
    config,
    refresh: async () => {
      refreshed = true;
      read({ carbonIntensity: 61 });
    },
  });
  assert.equal(refreshed, true);
  assert.match(toast.fr, /61/);
  assert.ok(toast.en.length <= 200, 'a toast holds 200 characters');
});

test('an action key the content never declared is ignored, not obeyed', async () => {
  const gladys = gladysWith({ deviceCreated: true });
  let refreshed = false;
  const toast = await widget.action(gladys, {
    actionKey: 'wipe_everything',
    config,
    refresh: async () => {
      refreshed = true;
    },
  });
  assert.equal(toast, undefined);
  assert.equal(refreshed, false);
});

test('the card falls back to plain values when the device list is unreachable', async () => {
  read();
  const gladys = gladysWith({ deviceCreated: false });
  gladys.getDevices = async () => {
    throw new Error('host API unreachable');
  };
  const content = await widget.get(gladys, { config });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(!typesOf(content).includes('chart'));
});

// Keep this one LAST: the refusal of the power breakdown is remembered for the
// whole process, and every test above describes the optimistic default.
test('the renewable tile disappears once the plan refuses the endpoint', async () => {
  const gladys = gladysWith({ deviceCreated: true });
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await gridCarbon.probeCapabilities(gladys, config);

  assert.equal(
    gridCarbon.featureExternalIds(gladys, config).renewable,
    null,
    'the feature is not published either',
  );
  read();
  const content = await widget.get(gladys, { config });
  const tiles = content.components.filter((component) => component.type === 'value');
  assert.equal(tiles.length, 2, 'a tile bound to an unpublished feature would read empty forever');
  assert.deepEqual(validateWidgetContent(content), []);
});
