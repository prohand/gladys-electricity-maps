import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  capabilitiesSignature,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import {
  GRAM_CO2EQ_PER_KILOWATT_HOUR,
  GRID_CARBON_SENSOR,
  GRID_CARBON_TYPES,
} from '../src/features.js';
import { normalizeConfig } from '../src/config.js';
import { CARBON_LEVELS } from '../src/carbonLevel.js';
import { readGridSnapshot, resetGridSnapshot } from '../src/gridSnapshot.js';
import { SCENE_TRIGGERS } from '../src/scenes.js';
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
    assert.equal(
      typeof bp.onDeviceCreated,
      'function',
      'onDeviceCreated must be a function: a brand new device must not stay empty',
    );
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

test('every feature is published in the grid carbon category', () => {
  // This is what makes Gladys name, group and chart the sensors instead of
  // showing three "Unknown" features.
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  for (const feature of device.features) {
    assert.equal(feature.category, GRID_CARBON_SENSOR, `${feature.name} category`);
  }
  assert.deepEqual(
    device.features.map((f) => f.type),
    [
      GRID_CARBON_TYPES.CARBON_INTENSITY,
      GRID_CARBON_TYPES.CARBON_FREE_PERCENTAGE,
      GRID_CARBON_TYPES.RENEWABLE_PERCENTAGE,
    ],
    'one feature per type of the category',
  );
});

test('the carbon intensity declares the gCO2eq/kWh unit, not a unit in its name', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, config);
  const [intensity] = device.features;
  assert.equal(intensity.unit, GRAM_CO2EQ_PER_KILOWATT_HOUR);
  assert.doesNotMatch(intensity.name, /kWh/, 'Gladys renders the unit itself');
  assert.equal(intensity.min, 0);
  assert.ok(intensity.max > 900, 'the dirtiest zones must fit in the gauge');
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

test('onDeviceCreated publishes right away, without waiting for the next tick', async () => {
  // The user adds the device from the discovery list: the sensors must show a
  // value immediately, not after a full poll_frequency (900 s by default).
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const freshConfig = normalizeConfig({ api_token: 'created-token', zone: 'FR' });
  stubApi({ status: gridStatus(), breakdown: { renewablePercentage: 30 } });

  await bp.onDeviceCreated(gladys, freshConfig);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92, 30],
    'the three sensors are filled in as soon as the device exists',
  );
});

test('onDeviceCreated replays the last poll instead of spending an API request', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const cachedConfig = normalizeConfig({ api_token: 'cached-token', zone: 'FR' });
  let apiCalls = 0;
  const stub = (opts) => {
    stubApi(opts);
    const inner = globalThis.fetch;
    globalThis.fetch = async (url) => {
      apiCalls += 1;
      return inner(url);
    };
  };

  // A tick ran before the user created the device: Gladys dropped those states.
  stub({ status: gridStatus(), breakdown: { renewablePercentage: 30 } });
  await bp.onPoll(gladys, cachedConfig);
  const callsAfterPoll = apiCalls;
  gladys.published.length = 0;

  await bp.onDeviceCreated(gladys, cachedConfig);

  assert.equal(apiCalls, callsAfterPoll, 'a fresh cache must not cost another request');
  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92, 30],
    'the values read a moment ago are republished to the new device',
  );
});

test('onDeviceCreated ignores a cache read for another zone', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const frConfig = normalizeConfig({ api_token: 'zone-token', zone: 'FR' });
  const deConfig = normalizeConfig({ api_token: 'zone-token', zone: 'DE' });

  stubApi({ status: gridStatus(), breakdown: { renewablePercentage: 30 } });
  await bp.onPoll(gladys, frConfig);
  gladys.published.length = 0;

  stubApi({ status: gridStatus({ carbonIntensity: 400 }), breakdown: { renewablePercentage: 12 } });
  await bp.onDeviceCreated(gladys, deConfig);

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [400, 92, 12],
    'the German device must not inherit the French values',
  );
  for (const { featureExternalId } of gladys.published) {
    assert.match(featureExternalId, /:DE:/, 'the states target the DE device');
  }
});

test('onDeviceCreated reads live again once the cache is older than one interval', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const staleConfig = normalizeConfig({
    api_token: 'stale-token',
    zone: 'FR',
    poll_frequency: 300,
  });

  stubApi({ status: gridStatus(), breakdown: { renewablePercentage: 30 } });
  await bp.onPoll(gladys, staleConfig);
  gladys.published.length = 0;

  // The device is created long after that read: the loop would have refreshed
  // it by now, so the cached batch is not what the user should see.
  const realNow = Date.now;
  Date.now = () => realNow() + 301 * 1000;
  try {
    stubApi({
      status: gridStatus({ carbonIntensity: 12 }),
      breakdown: { renewablePercentage: 80 },
    });
    await bp.onDeviceCreated(gladys, staleConfig);
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [12, 92, 80],
    'a stale cache is refreshed instead of being replayed',
  );
});

test('a plan that refuses the breakdown gets a device without the renewable sensor', async () => {
  // The free "Home Assistant" access answers 401 there: a sensor no endpoint
  // can ever fill must not be advertised, or the user faces a "no recent
  // value" tile forever.
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const freeConfig = normalizeConfig({ api_token: 'probe-refused-token', zone: 'FR' });
  stubApi({ status: gridStatus(), breakdown: 401 });

  await bp.probeCapabilities(gladys, freeConfig);

  const [device] = buildDiscoveredDevices(gladys, freeConfig);
  assert.deepEqual(
    device.features.map((f) => f.type),
    [GRID_CARBON_TYPES.CARBON_INTENSITY, GRID_CARBON_TYPES.CARBON_FREE_PERCENTAGE],
    'only the two sensors the plan actually serves',
  );
  assert.equal(bp.capabilitiesSignature(freeConfig), 'no-renewable');
});

test('a plan that serves the breakdown keeps the three sensors', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const paidConfig = normalizeConfig({ api_token: 'probe-allowed-token', zone: 'FR' });
  stubApi({
    status: gridStatus(),
    breakdown: { fossilFreePercentage: 92, renewablePercentage: 28 },
  });

  await bp.probeCapabilities(gladys, paidConfig);

  const [device] = buildDiscoveredDevices(gladys, paidConfig);
  assert.equal(device.features.length, 3);
  assert.equal(device.features[2].type, GRID_CARBON_TYPES.RENEWABLE_PERCENTAGE);
  assert.equal(bp.capabilitiesSignature(paidConfig), 'renewable');
});

test('the probe hands its reading over to the poll instead of paying twice', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const reuseConfig = normalizeConfig({ api_token: 'probe-reuse-token', zone: 'FR' });
  stubApi({
    status: gridStatus(),
    breakdown: { fossilFreePercentage: 92, renewablePercentage: 28 },
  });
  const stubbedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return stubbedFetch(url, options);
  };

  await bp.probeCapabilities(gladys, reuseConfig);
  await bp.onPoll(gladys, reuseConfig);

  assert.equal(
    calls.filter((url) => url.includes('/power-breakdown/')).length,
    1,
    'the probe request is the poll request',
  );
  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [57, 92, 28],
    'the probed renewable share is published, not thrown away',
  );
});

test('a probe that fails on anything but the plan keeps the renewable sensor', async () => {
  // A network error says nothing about what the plan serves: publish the
  // sensor and let a later poll settle it.
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const flakyConfig = normalizeConfig({ api_token: 'probe-flaky-token', zone: 'FR' });
  stubApi({ status: gridStatus(), breakdown: new Error('network down') });

  await bp.probeCapabilities(gladys, flakyConfig);

  const [device] = buildDiscoveredDevices(gladys, flakyConfig);
  assert.equal(device.features.length, 3, 'undecided means still advertised');
  assert.equal(bp.capabilitiesSignature(flakyConfig), 'renewable');
});

test('the probe is skipped when nothing is configured yet', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const empty = normalizeConfig({ api_token: '', zone: 'FR' });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('the probe must not call the API without a token');
  };

  await bp.probeCapabilities(gladys, empty);

  assert.equal(calls, 0);
  assert.equal(buildDiscoveredDevices(gladys, empty)[0].features.length, 3);
});

test('a refusal discovered by a poll changes what the devices advertise', async () => {
  // The probe could not settle it (network error), so the device went out with
  // the three sensors; the poll then gets the 401. index.js watches this
  // signature to re-publish the devices without the renewable sensor.
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const lateConfig = normalizeConfig({ api_token: 'late-refusal-token', zone: 'FR' });
  assert.equal(capabilitiesSignature(lateConfig), 'grid-carbon=renewable');

  stubApi({ status: gridStatus(), breakdown: 401 });
  await bp.onPoll(gladys, lateConfig);

  assert.equal(capabilitiesSignature(lateConfig), 'grid-carbon=no-renewable');
  assert.equal(buildDiscoveredDevices(gladys, lateConfig)[0].features.length, 2);
});

// --- What a poll hands over to the widget and to the scenes ------------------

test('a poll records what it read, for the widget and the scene action', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const zoneConfig = normalizeConfig({ api_token: 'snapshot-token', zone: 'BE' });
  resetGridSnapshot();

  stubApi({
    status: gridStatus({ carbonIntensity: 210, fossilFuelPercentage: 30 }),
    breakdown: { fossilFreePercentage: 70, renewablePercentage: 24 },
  });
  await bp.onPoll(gladys, zoneConfig);

  const snapshot = readGridSnapshot(zoneConfig);
  assert.equal(snapshot.zone, 'BE');
  assert.equal(snapshot.carbonIntensity, 210);
  assert.equal(snapshot.carbonFreePercentage, 70);
  assert.equal(snapshot.renewablePercentage, 24);
  assert.equal(snapshot.level, CARBON_LEVELS.MODERATE);
});

test('a poll that changes the level fires the scene trigger, after the states', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const zoneConfig = normalizeConfig({ api_token: 'trigger-token', zone: 'NL' });
  resetGridSnapshot();

  stubApi({ status: gridStatus({ carbonIntensity: 60 }), breakdown: 401 });
  await bp.onPoll(gladys, zoneConfig);
  assert.deepEqual(gladys.sceneEvents, [], 'the first reading is not a transition');

  stubApi({ status: gridStatus({ carbonIntensity: 480 }), breakdown: 401 });
  await bp.onPoll(gladys, zoneConfig);

  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, SCENE_TRIGGERS.CARBON_LEVEL_CHANGED);
  assert.equal(gladys.sceneEvents[0].data.level, CARBON_LEVELS.HIGH);
  const ids = gladys.externalIds('grid-carbon', 'NL');
  assert.deepEqual(
    gladys.published.filter((p) => p.featureExternalId === ids.feature('carbon-intensity')),
    [
      { featureExternalId: ids.feature('carbon-intensity'), state: 60 },
      { featureExternalId: ids.feature('carbon-intensity'), state: 480 },
    ],
    'the states are published before the event describing them',
  );
});

test('a poll that read nothing records nothing', async () => {
  const gladys = createFakeGladys();
  const [bp] = DEVICE_BLUEPRINTS;
  const zoneConfig = normalizeConfig({ api_token: 'dead-token', zone: 'PT' });
  resetGridSnapshot();

  stubApi({ status: new Error('down'), breakdown: 401 });
  await assert.rejects(() => bp.onPoll(gladys, zoneConfig));

  assert.equal(readGridSnapshot(zoneConfig), null, 'no reading, no snapshot to serve');
  assert.deepEqual(gladys.sceneEvents, []);
});
