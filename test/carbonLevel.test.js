// -----------------------------------------------------------------------------
// Carbon level bands and their hysteresis.
//
// The bands are what the `carbon_level_changed` scene trigger fires on, so a
// mistake here is a scene starting at the wrong moment — or starting again and
// again on a value sitting on a boundary. Both are tested.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARBON_LEVELS,
  CARBON_LEVEL_BANDS,
  CARBON_LEVEL_DIRECTIONS,
  CARBON_LEVEL_HYSTERESIS,
  carbonLevelColor,
  carbonLevelDirection,
  carbonLevelLabel,
  classifyCarbonIntensity,
} from '../src/carbonLevel.js';

test('a value with no history lands in its band', () => {
  assert.equal(classifyCarbonIntensity(0), CARBON_LEVELS.VERY_LOW);
  assert.equal(classifyCarbonIntensity(57), CARBON_LEVELS.VERY_LOW);
  assert.equal(classifyCarbonIntensity(99.9), CARBON_LEVELS.VERY_LOW);
  assert.equal(classifyCarbonIntensity(100), CARBON_LEVELS.LOW);
  assert.equal(classifyCarbonIntensity(199), CARBON_LEVELS.LOW);
  assert.equal(classifyCarbonIntensity(200), CARBON_LEVELS.MODERATE);
  assert.equal(classifyCarbonIntensity(399), CARBON_LEVELS.MODERATE);
  assert.equal(classifyCarbonIntensity(400), CARBON_LEVELS.HIGH);
  assert.equal(classifyCarbonIntensity(599), CARBON_LEVELS.HIGH);
  assert.equal(classifyCarbonIntensity(600), CARBON_LEVELS.VERY_HIGH);
  assert.equal(classifyCarbonIntensity(2000), CARBON_LEVELS.VERY_HIGH);
});

test('a value that is not a number has no level', () => {
  for (const value of [null, undefined, Number.NaN, 'abc']) {
    assert.equal(classifyCarbonIntensity(value), null);
    assert.equal(classifyCarbonIntensity(value, CARBON_LEVELS.LOW), null);
  }
});

test('an unknown previous level is treated as no history', () => {
  assert.equal(classifyCarbonIntensity(105, 'nonsense'), CARBON_LEVELS.LOW);
});

test('crossing a boundary by less than the margin keeps the previous level', () => {
  // 100 is the very low / low boundary: 105 is past it, but not by 10.
  assert.equal(classifyCarbonIntensity(105, CARBON_LEVELS.VERY_LOW), CARBON_LEVELS.VERY_LOW);
  // And the same coming back down from `low`.
  assert.equal(classifyCarbonIntensity(95, CARBON_LEVELS.LOW), CARBON_LEVELS.LOW);
});

test('crossing a boundary by the margin changes the level', () => {
  assert.equal(classifyCarbonIntensity(110, CARBON_LEVELS.VERY_LOW), CARBON_LEVELS.LOW);
  assert.equal(classifyCarbonIntensity(90, CARBON_LEVELS.LOW), CARBON_LEVELS.VERY_LOW);
});

test('a value oscillating around a boundary never flips the level', () => {
  let level = classifyCarbonIntensity(96);
  assert.equal(level, CARBON_LEVELS.VERY_LOW);
  for (const value of [101, 97, 104, 99, 103, 98]) {
    level = classifyCarbonIntensity(value, level);
    assert.equal(level, CARBON_LEVELS.VERY_LOW, `${value} must not change the level`);
  }
});

test('the margin is applied to the boundary that was actually crossed', () => {
  // Jumping several bands at once: the margin belongs to the boundary just
  // above the previous band, not to the one of the new band.
  assert.equal(classifyCarbonIntensity(450, CARBON_LEVELS.VERY_LOW), CARBON_LEVELS.HIGH);
  assert.equal(classifyCarbonIntensity(50, CARBON_LEVELS.VERY_HIGH), CARBON_LEVELS.VERY_LOW);
});

test('the margin is small in front of the narrowest band', () => {
  const narrowest = Math.min(
    ...CARBON_LEVEL_BANDS.filter((band) => Number.isFinite(band.max)).map(
      (band, index, bands) => band.max - (index === 0 ? 0 : bands[index - 1].max),
    ),
  );
  assert.ok(
    CARBON_LEVEL_HYSTERESIS * 2 < narrowest,
    'the margin must never be able to swallow a whole band',
  );
});

test('the direction says which way the grid moved', () => {
  assert.equal(
    carbonLevelDirection(CARBON_LEVELS.MODERATE, CARBON_LEVELS.LOW),
    CARBON_LEVEL_DIRECTIONS.CLEANER,
  );
  assert.equal(
    carbonLevelDirection(CARBON_LEVELS.LOW, CARBON_LEVELS.VERY_HIGH),
    CARBON_LEVEL_DIRECTIONS.DIRTIER,
  );
});

test('every level has a label and a colour, in both languages', () => {
  for (const level of Object.values(CARBON_LEVELS)) {
    const label = carbonLevelLabel(level);
    assert.ok(label.en, `${level} needs an English label`);
    assert.ok(label.fr, `${level} needs a French label`);
    assert.ok(label.en.length <= 40, 'a status value holds 40 characters');
    assert.ok(typeof carbonLevelColor(level) === 'string');
  }
  // An unknown level must still render something rather than break the card.
  assert.ok(carbonLevelLabel(null).en);
  assert.equal(carbonLevelColor(null), 'neutral');
});

test('the bands cover the whole range, in order, without a hole', () => {
  let previousMax = 0;
  for (const band of CARBON_LEVEL_BANDS) {
    assert.ok(band.max > previousMax, `${band.key} must come after the previous band`);
    previousMax = band.max;
  }
  assert.equal(CARBON_LEVEL_BANDS.at(-1).max, Infinity, 'the last band has no upper bound');
});
