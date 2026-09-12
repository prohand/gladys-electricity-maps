// -----------------------------------------------------------------------------
// Driver of the Electricity Maps API (https://portal.electricitymaps.com).
//
// This is the only file that talks to the outside world. Two endpoints of the
// free "personal" plan are used, both for the zone configured by the user:
//   - GET /v3/carbon-intensity/latest -> gCO2eq per kWh consumed right now;
//   - GET /v3/power-breakdown/latest  -> share of carbon-free and renewable
//     power in that same consumption.
//
// Authentication is a single `auth-token` header. Node 20+ ships `fetch`
// natively, so no HTTP dependency is needed.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'electricity-maps' });

const API_BASE_URL = 'https://api.electricitymap.org/v3';
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
 * Latest carbon intensity of the zone.
 * @param {{ api_token: string, zone: string }} config
 * @returns {Promise<{ carbonIntensity: number, datetime: string|null, isEstimated: boolean }>}
 */
export async function fetchCarbonIntensity({ api_token: apiToken, zone }) {
  const body = await request('/carbon-intensity/latest', { apiToken, zone });

  return {
    carbonIntensity: toNumber(body.carbonIntensity),
    datetime: body.datetime ?? null,
    isEstimated: body.isEstimated === true,
  };
}

/**
 * Latest power breakdown of the zone. Only the consumption-side summary is
 * kept: it is what a home actually plugs into.
 * @param {{ api_token: string, zone: string }} config
 * @returns {Promise<{ fossilFreePercentage: number, renewablePercentage: number, datetime: string|null, isEstimated: boolean }>}
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
 * @param {string} path endpoint path, e.g. '/carbon-intensity/latest'
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
      return 'Invalid API token (HTTP 401)';
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
