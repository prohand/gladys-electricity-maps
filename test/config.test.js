import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigured, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({ api_token: 'abc', zone: 'DE', poll_frequency: 3600 });
  assert.equal(config.api_token, 'abc');
  assert.equal(config.zone, 'DE');
  assert.equal(config.poll_frequency, 3600);
});

test('normalizeConfig upper-cases the zone and trims the token', () => {
  const config = normalizeConfig({ api_token: '  my-token  ', zone: ' us-cal-ciso ' });
  assert.equal(config.api_token, 'my-token');
  assert.equal(config.zone, 'US-CAL-CISO');
});

test('normalizeConfig coerces a numeric string coming from the form', () => {
  const config = normalizeConfig({ poll_frequency: '1800' });
  assert.equal(config.poll_frequency, 1800);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps the refresh interval to the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 10 }).poll_frequency, 300);
  assert.equal(normalizeConfig({ poll_frequency: 999999 }).poll_frequency, 86400);
});

test('normalizeConfig falls back to the default refresh interval for a bad value', () => {
  assert.equal(
    normalizeConfig({ poll_frequency: 'soon' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
  assert.equal(
    normalizeConfig({ poll_frequency: -5 }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('isConfigured requires both a token and a zone', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ api_token: 'abc' })), true);
  assert.equal(isConfigured(normalizeConfig({ api_token: 'abc', zone: '' })), false);
});
