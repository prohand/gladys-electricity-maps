// -----------------------------------------------------------------------------
// Driver of the Electricity Maps API (https://portal.electricitymaps.com).
//
// This is the only file that talks to the outside world.
//
// IMPORTANT — which endpoint a free key may call. The free "Home Assistant"
// (free tier) access serves ONE endpoint, for the single zone attached to the
// key:
//   - GET /v3/home-assistant -> carbon intensity (gCO2eq/kWh) + share of the
//     consumption coming from fossil fuels (%).
// The "full" endpoints (/v3/carbon-intensity/latest, /v3/power-breakdown/latest)
// belong to the paid plans and answer 401 to a free key — which is exactly the
// "Invalid API token" a correctly configured free key used to get here.
//
// So the carbon intensity and the carbon-free share are read from
// /v3/home-assistant (works on every plan), and the renewable share stays on
// /v3/power-breakdown/latest, tried once and then left alone when the plan
// refuses it (see src/devices/gridCarbon.js).
//
// Authentication is a single `auth-token` header. Node 20+ ships `fetch`
// natively, so no HTTP dependency is needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'electricity-maps' });

// Current API domain, the one the Electricity Maps clients use today
// (api.electricitymap.org is the historical alias of the same service).
const API_BASE_URL = 'https://api.electricitymaps.com/v3';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Error carrying the HTTP status, so callers can tell a bad token (401) from a
 * quota problem (429) without parsing a string.
 */
export class ElectricityMapsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ElectricityMapsError';
    this.status = status;
  }
}

/**
 * Latest grid status of the zone, from the endpoint every plan can call.
 * `fossilFuelPercentage` is turned into its complement: the carbon-free share
 * (renewables + nuclear) is the value the integration publishes, and it is the
 * same quantity as the `fossilFreePercentage` of the power breakdown.
 * @param {{ api_token: string, zone: string }} config
 * @returns {Promise<{ carbonIntensity: number|null, fossilFreePercentage: number|null }>}
 */
export async function fetchGridStatus({ api_token: apiToken, zone }) {
  const body = await request('/home-assistant', { apiToken, zone });

  // The endpoint answers 200 with `status: 'no-data'` when the zone has no
  // measurement for the current hour: that is not an HTTP error, but there is
  // nothing to publish either.
  if (body.status && body.status !== 'ok') {
    throw new ElectricityMapsError(`No data available for zone "${zone}" right now`, 204);
  }

  const data = body.data ?? {};
  const fossilFuelPercentage = toNumber(data.fossilFuelPercentage);

  return {
    carbonIntensity: toNumber(data.carbonIntensity),
    fossilFreePercentage: fossilFuelPercentage === null ? null : round1(100 - fossilFuelPercentage),
  };
}

/**
 * Latest power breakdown of the zone — PAID PLANS ONLY, a free key gets a 401.
 * Only the consumption-side summary is kept: it is what a home actually plugs
 * into.
 * @param {{ api_token: string, zone: string }} config
 * @returns {Promise<{ fossilFreePercentage: number|null, renewablePercentage: number|null, datetime: string|null, isEstimated: boolean }>}
 */
export async function fetchPowerBreakdown({ api_token: apiToken, zone }) {
  const body = await request('/power-breakdown/latest', { apiToken, zone });

  return {
    fossilFreePercentage: toNumber(body.fossilFreePercentage),
    renewablePercentage: toNumber(body.renewablePercentage),
    datetime: body.datetime ?? null,
    isEstimated: body.isEstimated === true,
  };
}

/**
 * GET one endpoint of the API and return its parsed body.
 * @param {string} path endpoint path, e.g. '/home-assistant'
 * @param {{ apiToken: string, zone: string }} auth
 */
async function request(path, { apiToken, zone }) {
  if (!apiToken) {
    throw new ElectricityMapsError('No API token configured', 401);
  }

  const url = `${API_BASE_URL}${path}?zone=${encodeURIComponent(zone)}`;
  logger.debug(`Electricity Maps request -> ${url}`);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'auth-token': apiToken },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout: never leak the token in the message.
    throw new ElectricityMapsError(`Electricity Maps unreachable: ${err.message}`, 0);
  }

  if (!response.ok) {
    throw new ElectricityMapsError(await describeHttpError(response, zone), response.status);
  }

  return response.json();
}

/**
 * Turn a non-2xx response into an actionable message: the user has to know
 * whether to fix the token, the zone, or to wait for the quota to reset.
 */
async function describeHttpError(response, zone) {
  const detail = await readErrorDetail(response);

  switch (response.status) {
    case 401:
      // A free key is bound to one zone and to the endpoints of its plan, so a
      // 401 is not necessarily a typo in the token.
      return `Invalid API token, or a token that does not cover zone "${zone}" (HTTP 401)`;
    case 403:
      return `Zone "${zone}" is not allowed by your Electricity Maps plan (HTTP 403)`;
    case 404:
      return `Unknown zone "${zone}" (HTTP 404)`;
    case 429:
      return 'Electricity Maps quota exceeded (HTTP 429)';
    default:
      return `Electricity Maps HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
  }
}

/**
 * Best-effort extraction of the API error message. A failing response must
 * never turn into a second failure here.
 */
async function readErrorDetail(response) {
  try {
    const body = await response.json();
    return body?.message ?? body?.error ?? '';
  } catch {
    return '';
  }
}

/**
 * Coerce an API value to a number, `null` when the API sends nothing (some
 * zones have no breakdown data at a given hour).
 */
function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One decimal is enough for a percentage, and it keeps `100 - 27.3` from
 * landing in the history as 72.69999999999999.
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}
