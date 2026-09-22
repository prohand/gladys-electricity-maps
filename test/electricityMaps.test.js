import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGridStatus,
  fetchPowerBreakdown,
  ElectricityMapsError,
} from '../src/electricityMaps.js';

const realFetch = globalThis.fetch;
const CONFIG = { api_token: 'test-token', zone: 'FR' };

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Body served by GET /v3/home-assistant. */
function homeAssistantBody({ carbonIntensity = 57, fossilFuelPercentage = 8 } = {}) {
  return {
    status: 'ok',
    countryCode: 'FR',
    data: { carbonIntensity, fossilFuelPercentage },
    units: { carbonIntensity: 'gCO2eq/kWh' },
  };
}

test('fetchGridStatus returns the intensity and the carbon-free share', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => homeAssistantBody({ carbonIntensity: 57, fossilFuelPercentage: 8 }),
  });

  const result = await fetchGridStatus(CONFIG);
  assert.equal(result.carbonIntensity, 57);
  assert.equal(
    result.fossilFreePercentage,
    92,
    'carbon-free is the complement of the fossil share',
  );
});

test('fetchGridStatus returns the hour the value belongs to', async () => {
  // The endpoint serves hourly values: the hour is what lets the user compare
  // it with the right point of the Electricity Maps site.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      ...homeAssistantBody(),
      data: {
        carbonIntensity: 66,
        fossilFuelPercentage: 9.5,
        datetime: '2026-09-22T20:00:00.000Z',
      },
    }),
  });

  const result = await fetchGridStatus(CONFIG);
  assert.equal(result.datetime, '2026-09-22T20:00:00.000Z');
});

test('fetchGridStatus returns a null hour when the API sends none', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => homeAssistantBody() });

  const result = await fetchGridStatus(CONFIG);
  assert.equal(result.datetime, null);
});

test('fetchGridStatus calls the endpoint a free key is allowed to call', async () => {
  // The free "Home Assistant" access only serves /v3/home-assistant: calling
  // /v3/carbon-intensity/latest with a free key answers 401.
  let calledUrl;
  let calledOptions;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    calledOptions = options;
    return { ok: true, json: async () => homeAssistantBody() };
  };

  await fetchGridStatus({ api_token: 'secret', zone: 'US-CAL-CISO' });
  assert.match(
    calledUrl,
    /^https:\/\/api\.electricitymaps\.com\/v3\/home-assistant\?zone=US-CAL-CISO$/,
  );
  assert.equal(calledOptions.headers['auth-token'], 'secret');
});

test('fetchGridStatus rounds the carbon-free share to one decimal', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => homeAssistantBody({ fossilFuelPercentage: 27.3 }),
  });

  const result = await fetchGridStatus(CONFIG);
  assert.equal(result.fossilFreePercentage, 72.7);
});

test('fetchGridStatus reports a zone without data for the current hour', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'no-data' }) });

  await assert.rejects(
    () => fetchGridStatus({ ...CONFIG, zone: 'XX' }),
    /No data available for zone "XX"/,
  );
});

test('fetchPowerBreakdown returns the carbon-free and renewable shares', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ fossilFreePercentage: 92, renewablePercentage: 28, isEstimated: true }),
  });

  const result = await fetchPowerBreakdown(CONFIG);
  assert.equal(result.fossilFreePercentage, 92);
  assert.equal(result.renewablePercentage, 28);
  assert.equal(result.isEstimated, true);
});

test('a missing value comes back as null instead of NaN', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  const breakdown = await fetchPowerBreakdown(CONFIG);
  assert.equal(breakdown.fossilFreePercentage, null);
  assert.equal(breakdown.renewablePercentage, null);

  const status = await fetchGridStatus(CONFIG);
  assert.equal(status.carbonIntensity, null);
  assert.equal(status.fossilFreePercentage, null);
});

test('an empty token fails fast, without any HTTP call', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };

  await assert.rejects(() => fetchGridStatus({ api_token: '', zone: 'FR' }), {
    name: 'ElectricityMapsError',
    status: 401,
  });
  assert.equal(called, false, 'no request is sent without a token');
});

test('an invalid token is reported as such, and names the zone', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid auth-token' }),
  });

  // A free key only covers the zone it was created for: a 401 is as often a
  // wrong zone as a wrong token, and the message has to say so.
  await assert.rejects(() => fetchGridStatus(CONFIG), /Invalid API token.*zone "FR".*401/);
});

test('an unknown zone names the zone in the error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

  await assert.rejects(() => fetchGridStatus({ ...CONFIG, zone: 'XX' }), /Unknown zone "XX"/);
});

test('an exceeded quota is reported as such', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });

  await assert.rejects(() => fetchGridStatus(CONFIG), { status: 429, message: /quota/ });
});

test('a network failure is wrapped without leaking the token', async () => {
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.electricitymaps.com');
  };

  await assert.rejects(
    () => fetchGridStatus(CONFIG),
    (err) => {
      assert.ok(err instanceof ElectricityMapsError);
      assert.equal(err.status, 0);
      assert.match(err.message, /unreachable/);
      assert.ok(!err.message.includes('test-token'), 'the token never appears in an error message');
      return true;
    },
  );
});
