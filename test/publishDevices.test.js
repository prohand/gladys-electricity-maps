// -----------------------------------------------------------------------------
// Publication of the discovery payload, and its fallback.
//
// The `grid-carbon-sensor` category is validated by the core: a Gladys older
// than it rejects the WHOLE payload with a 400, which would leave the user
// without any device. publishDevices then republishes the same sensors as
// generic UNKNOWN features.
//
// This file is on its own on purpose: the fallback decision is a module-level
// one, taken once per process, and `node --test` runs each file in its own
// process, so it cannot leak into the other tests.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { publishDevices } from '../src/devices/index.js';
import { GRID_CARBON_SENSOR } from '../src/features.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig({ api_token: 'test-token', zone: 'FR' });

// publishDevices probes the power breakdown before building the payload (it
// decides whether the renewable sensor can hold a value): answer it here, so
// no test in this file ever reaches the real API. A plan that serves it keeps
// the three sensors, which is what these tests describe.
globalThis.fetch = async (url) => {
  if (String(url).includes('/power-breakdown/')) {
    return { ok: true, json: async () => ({ fossilFreePercentage: 92, renewablePercentage: 28 }) };
  }
  return { ok: true, json: async () => ({ status: 'ok', data: {} }) };
};

/** The error the core answers on a category it does not know. */
function unknownCategoryError() {
  const err = new Error('devices[0].features[0].category: unknown category');
  err.status = 400;
  err.code = 'BAD_REQUEST';
  return err;
}

test('publishes the grid carbon category on a core that knows it', async () => {
  const gladys = createFakeGladys();

  await publishDevices(gladys, config);

  assert.equal(gladys.publishedDevices.length, 1, 'no retry needed');
  for (const feature of gladys.publishedDevices[0][0].features) {
    assert.equal(feature.category, GRID_CARBON_SENSOR);
  }
});

test('falls back to generic features when the core refuses the category', async () => {
  const gladys = createFakeGladys({
    onPublishDevices: (devices, attempt) => {
      if (attempt === 0) {
        throw unknownCategoryError();
      }
    },
  });

  await publishDevices(gladys, config);

  assert.equal(gladys.publishedDevices.length, 2, 'refused once, then republished');
  const [device] = gladys.publishedDevices[1];
  for (const feature of device.features) {
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.UNKNOWN);
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN);
  }
  const [intensity] = device.features;
  assert.equal(intensity.unit, undefined, 'the unit does not exist on that core either');
  assert.match(intensity.name, /gCO₂eq\/kWh/, 'so it moves into the name');
  assert.equal(device.features[1].unit, 'percent', 'a standard unit is kept');
});

test('the fallback is remembered: the category is not sent again', async () => {
  // Same process as the test above: the decision was taken there, so this
  // publish must go out downgraded on the FIRST attempt.
  const gladys = createFakeGladys();

  await publishDevices(gladys, config);

  assert.equal(gladys.publishedDevices.length, 1, 'no second refusal to absorb');
  for (const feature of gladys.publishedDevices[0][0].features) {
    assert.equal(feature.category, DEVICE_FEATURE_CATEGORIES.UNKNOWN);
  }
});

test('any other publication error keeps bubbling up', async () => {
  const gladys = createFakeGladys({
    onPublishDevices: () => {
      const err = new Error('Invalid token');
      err.status = 401;
      throw err;
    },
  });

  await assert.rejects(() => publishDevices(gladys, config), /Invalid token/);
  assert.equal(gladys.publishedDevices.length, 1, 'no blind retry');
});

test('nothing is published while the API token is missing', async () => {
  // Reported bug: the device showed up in the Discovery screen before the user
  // had pasted any token, with sensors nothing could ever fill.
  const gladys = createFakeGladys();

  const published = await publishDevices(gladys, normalizeConfig({ zone: 'FR' }));

  assert.equal(published, false, 'publishDevices reports it published nothing');
  assert.equal(gladys.publishedDevices.length, 0, 'no discovery payload sent');
});

test('nothing is published while the zone is missing either', async () => {
  const gladys = createFakeGladys();

  const published = await publishDevices(gladys, normalizeConfig({ api_token: 't', zone: '' }));

  assert.equal(published, false);
  assert.equal(gladys.publishedDevices.length, 0);
});
