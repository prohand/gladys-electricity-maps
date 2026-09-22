// -----------------------------------------------------------------------------
// Scene editor surface: one TRIGGER and one ACTION, declared in the
// `scene_triggers` and `scene_actions` fields of the manifest and rendered by
// the Gladys core (the integration never learns which scenes exist).
//
// WHAT IS A TRIGGER HERE, AND WHAT IS NOT. The SDK doctrine is "state vs
// event": a value is a device feature, an event says "this happened". The
// carbon intensity, the carbon-free share and the renewable share are states —
// they are published as sensors, and a scene comparing them to a threshold
// already has the core's own device trigger. Declaring "carbon intensity above
// X" here would duplicate it, worse (no operator, no duration).
//
// What the core cannot express is the TRANSITION: "the grid just became
// clean". That needs the previous reading, a hysteresis and a wording the user
// can pick from a list — so `carbon_level_changed` is the only trigger, and it
// fires ONCE per real level change (src/carbonLevel.js holds the bands and the
// margin that keeps a value sitting on a boundary from flapping).
//
// The ACTION is the mirror image: a scene needs the figures to decide, and a
// scene runs when it runs, not when the refresh loop ticks. `get_grid_data`
// hands over the last reading, and reads Electricity Maps live when the scene
// author ticks "Refresh first" — an explicit choice, because a free key has a
// monthly request quota.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isConfigured } from './config.js';
import { carbonLevelDirection } from './carbonLevel.js';
import { gridSnapshotAgeSeconds, readGridSnapshot } from './gridSnapshot.js';

const logger = createLogger({ name: 'scenes' });

/** Trigger keys, as declared in the manifest. A published key is never renamed. */
export const SCENE_TRIGGERS = {
  CARBON_LEVEL_CHANGED: 'carbon_level_changed',
};

/**
 * Fire the `carbon_level_changed` trigger for a reading that just landed.
 *
 * Fires nothing when there is no transition to report:
 *   - the very first reading of a token+zone pair (no previous level: the grid
 *     did not change, we simply started looking at it);
 *   - a reading that stayed in the same band, hysteresis included.
 *
 * A failure here must never fail the poll that produced the values: the states
 * are already published, and the next transition will fire its own event.
 *
 * @param {object} gladys SDK instance
 * @param {import('./gridSnapshot.js').GridSnapshot} snapshot reading just stored
 * @returns {Promise<boolean>} whether an event was published
 */
export async function publishCarbonLevelEvent(gladys, snapshot) {
  const { level, previousLevel } = snapshot;
  if (level === null || previousLevel === null || level === previousLevel) {
    return false;
  }
  const direction = carbonLevelDirection(previousLevel, level);
  logger.info(`Carbon level ${previousLevel} -> ${level} (${direction}) in zone ${snapshot.zone}`);
  try {
    await gladys.publishSceneEvent(SCENE_TRIGGERS.CARBON_LEVEL_CHANGED, {
      zone: snapshot.zone,
      level,
      previous_level: previousLevel,
      direction,
      carbon_intensity: snapshot.carbonIntensity,
      carbon_free_percentage: snapshot.carbonFreePercentage,
      renewable_percentage: snapshot.renewablePercentage,
    });
    return true;
  } catch (err) {
    logger.error('Publishing the carbon level event failed', err);
    return false;
  }
}

/**
 * Handlers of the manifest `scene_actions`, keyed by action key. Each one
 * receives the SDK instance and `{ fields, config, refresh }`:
 *   - `fields`  the values the scene author filled in, already resolved and
 *               validated by the core;
 *   - `config`  the current integration configuration;
 *   - `refresh` runs one tick of the refresh loop (src/poller.js), i.e. reads
 *               Electricity Maps and publishes the states.
 * The returned object is exposed to the following actions of the scene under
 * the `outputs` keys declared in the manifest; throwing fails that action only.
 */
export const SCENE_ACTIONS = {
  async get_grid_data(gladys, { fields, config, refresh }) {
    if (!isConfigured(config)) {
      throw new Error('Electricity Maps is not configured yet (API token or zone missing)');
    }
    if (fields?.refresh) {
      logger.info('Scene action get_grid_data -> live read requested');
      await refresh();
    }
    const snapshot = readGridSnapshot(config);
    if (snapshot === null) {
      // Either nothing was read yet, or the refresh the scene asked for failed.
      // Failing the action is the honest answer: the following actions must not
      // branch on values nobody ever measured.
      throw new Error(`No Electricity Maps reading available yet for zone ${config.zone}`);
    }
    return {
      zone: snapshot.zone,
      level: snapshot.level,
      carbon_intensity: snapshot.carbonIntensity,
      carbon_free_percentage: snapshot.carbonFreePercentage,
      renewable_percentage: snapshot.renewablePercentage,
      age_seconds: gridSnapshotAgeSeconds(snapshot),
    };
  },
};
