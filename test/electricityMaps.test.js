import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCarbonIntensity,
  fetchPowerBreakdown,
  ElectricityMapsError,
} from '../src/electricityMaps.js';

const realFetch = globalThis.fetch;
const CONFIG = { api_token: 'test-token', zone: 'FR' };

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('fetchCarbonIntensity returns the parsed intensity', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      zone: 'FR',
      carbonIntensity: 57,
      datetime: '2026-09-12T10:00:00.000Z',
      isEstimated: false,
    }),
  });

  const result = await fetchCarbonIntensity(CONFIG);
  assert.equal(result.carbonIntensity, 57);
  assert.equal(result.datetime, '2026-09-12T10:00:00.000Z');
  assert.equal(result.isEstimated, false);
});

test('fetchCarbonIntensity sends the auth-token header and the zone', async () => {
  let calledUrl;
  let calledOptions;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    calledOptions = options;
    return { ok: true, json: async () => ({ carbonIntensity: 100 }) };
  };

  await fetchCarbonIntensity({ api_token: 'secret', zone: 'US-CAL-CISO' });
  assert.match(calledUrl, /\/carbon-intensity\/latest\?zone=US-CAL-CISO$/);
  assert.equal(calledOptions.headers['auth-token'], 'secret');
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

  const result = await fetchPowerBreakdown(CONFIG);
  assert.equal(result.fossilFreePercentage, null);
  assert.equal(result.renewablePercentage, null);
});

test('an empty token fails fast, without any HTTP call', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };

  await assert.rejects(() => fetchCarbonIntensity({ api_token: '', zone: 'FR' }), {
    name: 'ElectricityMapsError',
    status: 401,
  });
  assert.equal(called, false, 'no request is sent without a token');
});

test('an invalid token is reported as such', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid auth-token' }),
  });

  await assert.rejects(() => fetchCarbonIntensity(CONFIG), /Invalid API token/);
});

test('an unknown zone names the zone in the error', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

  await assert.rejects(() => fetchCarbonIntensity({ ...CONFIG, zone: 'XX' }), /Unknown zone "XX"/);
});

test('an exceeded quota is reported as such', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });

  await assert.rejects(() => fetchCarbonIntensity(CONFIG), { status: 429, message: /quota/ });
});

test('a network failure is wrapped without leaking the token', async () => {
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.electricitymap.org');
  };

  await assert.rejects(
    () => fetchCarbonIntensity(CONFIG),
    (err) => {
      assert.ok(err instanceof ElectricityMapsError);
      assert.equal(err.status, 0);
      assert.match(err.message, /unreachable/);
      assert.ok(!err.message.includes('test-token'), 'the token never appears in an error message');
      return true;
    },
  );
});
