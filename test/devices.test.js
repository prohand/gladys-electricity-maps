import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const realFetch = globalThis.fetch;
const config = normalizeConfig({ api_token: 'test-token', zone: 'FR' });

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Answer both endpoints of a poll.
 * `status` is the body of /v3/home-assistant (or an Error to fail it),
 * `breakdown` the body of /v3/power-breakdown/latest (Error, or a status code
 * to answer, e.g. 401 for a plan that does not serve it).
 */
function stubApi({ status, breakdown }) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/home-assistant')) {
      if (status instanceof Error) {
        return { ok: false, status: 500, json: async () => ({ message: status.message }) };
      }
      return { ok: true, json: async () => status };
    }
    if (typeof breakdown === 'number') {
      return { ok: false, status: breakdown, json: async () => ({}) };
    }
    if (breakdown instanceof Error) {
      return { ok: false, status: 500, json: async () => ({ message: breakdown.message }) };
    }
    return { ok: true, json: async () => breakdown };
  };
}

/** Body of /v3/home-assistant for the given values. */
function gridStatus({ carbonIntensity = 57, fossilFuelPercentage = 8 } = {}) {
  return { status: 'ok', data: { carbonIntensity, fossilFuelPercentage } };
}

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.equal(typeof bp.deviceExternalId, 'function', 'deviceExternalId must be a function');
    assert.equal(typeof bp.buildDevice, 'function', 'buildDevice must be a function');
    assert.equal(typeof bp.onPoll, 'function', 'onPoll must be a function');
  }
});

test('buildDiscoveredDevices returns one payload per blueprint', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, DEVICE_BLUEPRINTS.length);
  for (const device of devices) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.external_id, 'each device has an external_id');
    assert.ok(Array.isArray(device.features) && device.features.length > 0);
  }
});

test('the device never declares a poll_frequency', () => {
  // The core validates `poll_frequency` against a closed list of values, in
  // milliseconds, capped at one minute; sending our own interval (in seconds)
  // gets the whole discovery payload rejected with a 400. The refresh is
  // driven by src/poller.js instead.
  const gladys = createFakeGladys();
  for (const seconds of [300, 900, 3600, 86400]) {
    const [device] = buildDiscoveredDevices(gladys, normalizeConfig({ poll_frequency: seconds }));
    assert.equal(device.poll_frequency, undefined);
    assert.ok(!('poll_frequency' in device), 'the key must not be sent at all');
  }
});

test('a changed refresh interval keeps the same device', () => {
  const gladys = createFakeGladys();
  const before = buildDiscoveredDevices(gladys, normalizeConfig({ poll_frequency: 900 }))[0];
  const after = buildDiscoveredDevices(gladys, normalizeConfig({ poll_frequency: 3600 }))[0];
  assert.equal(before.external_id, after.external_id, 'the device is upserted, not duplicated');
});

test('feature external_ids are unique inside the device', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  const ids = device.features.map((f) => f.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two features may share an external_id');
});

test('every feature is a read-only sensor kept in history', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  for (const feature of device.features) {
    assert.equal(feature.read_only, true, `${feature.name} is a measurement, not a command`);
    assert.equal(feature.keep_history, true, `${feature.name} must be charted over time`);
    assert.ok(feature.name, 'each feature is named');
  }
});

test('the percentage features declare the percent unit and a 0-100 range', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  const percents = device.features.filter((f) => f.unit === DEVICE_FEATURE_UNITS.PERCENT);
  assert.equal(percents.length, 2, 'carbon-free and renewable shares');
  for (const feature of percents) {
    assert.equal(feature.min, 0);
    assert.equal(feature.max, 100);
  }
});

test('the zone is part of the device identity and name', () => {
  const gladys = createFakeGladys();
  const [fr] = buildDiscoveredDevices(gladys, normalizeConfig({ zone: 'FR' }));
  const [de] = buildDiscoveredDevices(gladys, normalizeConfig({ zone: 'DE' }));
  assert.notEqual(fr.external_id, de.external_id, 'another zone is another device');
  assert.match(de.name, /DE/);
});

test('findBlueprintByDevice routes an external_id back to its owner blueprint', () => {
  const gladys = createFakeGladys();
  for (const bp of DEVICE_BLUEPRINTS) {
    const external_id = bp.deviceExternalId(gladys, config);
    assert.equal(findBlueprintByDevice(gladys, { external_id }, config), bp);
  }
});

test('findBlueprintByDevice ignores a device from another zone', () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const otherZoneId = bp.deviceExternalId(gladys, normalizeConfig({ zone: 'DE' }));
  assert.equal(findBlueprintByDevice(gladys, { external_id: otherZoneId }, config), undefined);
});

test('onPoll publishes the three values in a single batch', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  stubApi({
    status: gridStatus({ carbonIntensity: 57, fossilFuelPercentage: 8 }),
    breakdown: { fossilFreePercentage: 92, renewablePercentage: 28 },
  });

  await bp.onPoll(gladys, config);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92, 28],
  );
  for (const { featureExternalId } of gladys.published) {
    assert.ok(featureExternalId.startsWith(bp.deviceExternalId(gladys, config)));
  }
});

test('onPoll still publishes intensity and carbon-free when the breakdown fails', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  stubApi({ status: gridStatus(), breakdown: new Error('breakdown unavailable') });

  await bp.onPoll(gladys, config);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92],
    'one endpoint down must not lose the other',
  );
});

test('a plan that refuses the power breakdown is asked only once', async () => {
  // The free "Home Assistant" access answers 401 on /power-breakdown/latest:
  // the poll must keep working on the two other values, and stop spending a
  // request per poll on an endpoint the plan will never serve.
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  // Own token: the "plan refused" memory is keyed by token+zone, so this test
  // cannot leak its decision into the others.
  const freeConfig = normalizeConfig({ api_token: 'free-tier-token', zone: 'FR' });

  stubApi({ status: gridStatus(), breakdown: 401 });
  const stubbedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return stubbedFetch(url, options);
  };

  await bp.onPoll(gladys, freeConfig);
  await bp.onPoll(gladys, freeConfig);

  assert.equal(calls.filter((url) => url.includes('/power-breakdown/')).length, 1);
  assert.equal(calls.filter((url) => url.includes('/home-assistant')).length, 2);
  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92, 57, 92],
    'the values the plan does serve keep being published',
  );
});

test('onPoll skips the values the API did not provide', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  stubApi({
    status: gridStatus(),
    breakdown: { fossilFreePercentage: 92, renewablePercentage: null },
  });

  await bp.onPoll(gladys, config);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92],
    'a missing value must not be published as 0',
  );
});

test('onPoll throws when nothing at all could be read', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  stubApi({ status: new Error('down'), breakdown: new Error('down') });

  await assert.rejects(() => bp.onPoll(gladys, config));
  assert.equal(gladys.published.length, 0);
});

test('the test_connection action returns a multi-language message', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  stubApi({ status: gridStatus(), breakdown: {} });

  const message = await bp.actions.test_connection(gladys, { fields: {}, config });
  assert.match(message.en, /57/);
  assert.match(message.fr, /57/);
  assert.match(message.fr, /FR/);
});
