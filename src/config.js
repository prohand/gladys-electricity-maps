// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module only holds the defaults and normalizes the received object, so
// the rest of the code never deals with `undefined` or with a number arriving
// as a string from the form.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a test enforces it).
export const DEFAULT_CONFIG = {
  // Electricity Maps API token. Declared as a `secret` field: it is never sent
  // back to the frontend, and a secret field cannot carry a manifest default.
  api_token: '',
  // Zone identifier, e.g. 'FR', 'DE', 'US-CAL-CISO'. See the /v3/zones endpoint.
  zone: 'FR',
  // Seconds between two refreshes, honoured by the integration's own loop
  // (src/poller.js). It is NOT the device `poll_frequency` field: the core only
  // accepts a closed list of values capped at one minute, while Electricity
  // Maps refreshes roughly every hour and the free plan has a monthly request
  // quota, so polling faster buys nothing.
  poll_frequency: 900,
};

// Bounds mirrored from the manifest, used to keep an out-of-range value from
// hammering the API if it ever reaches us.
const POLL_FREQUENCY_MIN = 300;
const POLL_FREQUENCY_MAX = 86400;

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency);

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    api_token: String(raw.api_token ?? DEFAULT_CONFIG.api_token).trim(),
    // Zones are upper-case in the Electricity Maps API ('fr' is refused).
    zone: String(raw.zone ?? DEFAULT_CONFIG.zone)
      .trim()
      .toUpperCase(),
    poll_frequency: clampPollFrequency(pollFrequency),
  };
}

/**
 * Keep the refresh interval inside the manifest bounds; fall back to the
 * default when the value is not a usable number.
 */
function clampPollFrequency(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(Math.max(Math.round(value), POLL_FREQUENCY_MIN), POLL_FREQUENCY_MAX);
}

/**
 * The integration cannot do anything without a token and a zone: index.js uses
 * this to report an explicit connection status instead of failing on each poll.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return config.api_token.length > 0 && config.zone.length > 0;
}
