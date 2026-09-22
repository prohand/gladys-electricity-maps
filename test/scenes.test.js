// -----------------------------------------------------------------------------
// Scene surface: the `carbon_level_changed` trigger and the `get_grid_data`
// action.
//
// What is checked here is the contract a scene author relies on:
//   - the trigger fires ONCE per real level change, and never on the first
//     reading (nothing changed, we just started looking);
//   - the event data is flat and carries exactly the declared keys;
//   - the action returns the declared outputs, and only reads the API when the
//     scene author asked for it (a free key has a monthly quota).
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CARBON_LEVELS } from '../src/carbonLevel.js';
import { rememberGridSnapshot, resetGridSnapshot } from '../src/gridSnapshot.js';
import { SCENE_ACTIONS, SCENE_TRIGGERS, publishCarbonLevelEvent } from '../src/scenes.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig({ api_token: 'test-token', zone: 'FR' });

beforeEach(() => {
  resetGridSnapshot();
});

/** Record a reading, as a poll would. */
function read(carbonIntensity, extra = {}) {
  return rememberGridSnapshot(config, {
    carbonIntensity,
    carbonFreePercentage: 92,
    renewablePercentage: null,
    ...extra,
  });
}

test('the first reading fires nothing: the grid did not change', async () => {
  const gladys = createFakeGladys();
  const fired = await publishCarbonLevelEvent(gladys, read(57));
  assert.equal(fired, false);
  assert.deepEqual(gladys.sceneEvents, []);
});

test('a reading staying in the same band fires nothing', async () => {
  const gladys = createFakeGladys();
  read(57);
  const fired = await publishCarbonLevelEvent(gladys, read(72));
  assert.equal(fired, false);
  assert.deepEqual(gladys.sceneEvents, []);
});

test('a real level change fires the declared trigger, once', async () => {
  const gladys = createFakeGladys();
  read(57);
  const fired = await publishCarbonLevelEvent(gladys, read(250));
  assert.equal(fired, true);
  assert.equal(gladys.sceneEvents.length, 1);

  const [event] = gladys.sceneEvents;
  assert.equal(event.key, SCENE_TRIGGERS.CARBON_LEVEL_CHANGED);
  assert.deepEqual(event.data, {
    zone: 'FR',
    level: CARBON_LEVELS.MODERATE,
    previous_level: CARBON_LEVELS.VERY_LOW,
    direction: 'dirtier',
    carbon_intensity: 250,
    carbon_free_percentage: 92,
    renewable_percentage: null,
  });

  // Reading the same band again is not a new transition.
  assert.equal(await publishCarbonLevelEvent(gladys, read(260)), false);
  assert.equal(gladys.sceneEvents.length, 1);
});

test('a grid getting cleaner is reported as such', async () => {
  const gladys = createFakeGladys();
  read(450);
  await publishCarbonLevelEvent(gladys, read(60));
  assert.equal(gladys.sceneEvents[0].data.direction, 'cleaner');
  assert.equal(gladys.sceneEvents[0].data.level, CARBON_LEVELS.VERY_LOW);
});

test('the event data is flat and only holds primitives', async () => {
  const gladys = createFakeGladys();
  read(57);
  await publishCarbonLevelEvent(gladys, read(700, { renewablePercentage: 12 }));
  const { data } = gladys.sceneEvents[0];
  assert.ok(Object.keys(data).length <= 30, 'at most 30 keys per event');
  for (const [key, value] of Object.entries(data)) {
    const primitive =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 1000);
    assert.ok(primitive, `data.${key} must be a flat primitive, got ${typeof value}`);
  }
});

test('a core refusing the event never fails the poll that produced it', async () => {
  const gladys = createFakeGladys({
    onPublishSceneEvent() {
      throw new Error('429 too many events');
    },
  });
  read(57);
  assert.equal(await publishCarbonLevelEvent(gladys, read(250)), false);
});

test('get_grid_data returns the last reading without touching the API', async () => {
  const gladys = createFakeGladys();
  read(57, { renewablePercentage: 28 });
  let refreshed = false;
  const outputs = await SCENE_ACTIONS.get_grid_data(gladys, {
    fields: { refresh: false },
    config,
    refresh: async () => {
      refreshed = true;
    },
  });
  assert.equal(refreshed, false, 'the default must not spend an API request');
  assert.equal(outputs.zone, 'FR');
  assert.equal(outputs.level, CARBON_LEVELS.VERY_LOW);
  assert.equal(outputs.carbon_intensity, 57);
  assert.equal(outputs.carbon_free_percentage, 92);
  assert.equal(outputs.renewable_percentage, 28);
  assert.ok(outputs.age_seconds >= 0);
});

test('get_grid_data reads live when the scene author asked for it', async () => {
  const gladys = createFakeGladys();
  let refreshed = false;
  const outputs = await SCENE_ACTIONS.get_grid_data(gladys, {
    fields: { refresh: true },
    config,
    refresh: async () => {
      refreshed = true;
      read(410);
    },
  });
  assert.equal(refreshed, true);
  assert.equal(outputs.carbon_intensity, 410);
  assert.equal(outputs.level, CARBON_LEVELS.HIGH);
});

test('get_grid_data fails rather than inventing values', async () => {
  const gladys = createFakeGladys();
  await assert.rejects(
    () => SCENE_ACTIONS.get_grid_data(gladys, { fields: {}, config, refresh: async () => {} }),
    /No Electricity Maps reading available/,
    'the following actions must never branch on a value nobody measured',
  );

  const empty = normalizeConfig({ api_token: '', zone: 'FR' });
  await assert.rejects(
    () =>
      SCENE_ACTIONS.get_grid_data(gladys, { fields: {}, config: empty, refresh: async () => {} }),
    /not configured/,
  );
});

test('a reading of another zone is never served to a scene', async () => {
  const gladys = createFakeGladys();
  read(57);
  const otherZone = normalizeConfig({ api_token: 'test-token', zone: 'DE' });
  await assert.rejects(
    () =>
      SCENE_ACTIONS.get_grid_data(gladys, {
        fields: {},
        config: otherZone,
        refresh: async () => {},
      }),
    /No Electricity Maps reading available/,
  );
});

test('the outputs match the keys the manifest declares', async () => {
  const gladys = createFakeGladys();
  read(57);
  const outputs = await SCENE_ACTIONS.get_grid_data(gladys, {
    fields: {},
    config,
    refresh: async () => {},
  });
  for (const value of Object.values(outputs)) {
    assert.ok(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      'an output is a scalar',
    );
  }
});
