// -----------------------------------------------------------------------------
// Tests of the internal refresh loop (src/poller.js).
//
// Time is driven by the node:test fake timers, so a "one day" interval is
// exercised in microseconds and the suite stays instant.
// -----------------------------------------------------------------------------

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../src/poller.js';

/** Run `fn` with setInterval under our control. */
async function withFakeTimers(fn) {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
}

/** Let the pending async work settle (setImmediate is not faked). */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fire one interval tick, with the refreshes settled on both sides: the
 * `inFlight` guard only clears on a microtask, so ticking without draining
 * first would look like an overlapping refresh and be dropped.
 */
async function advance(seconds) {
  await flush();
  mock.timers.tick(seconds * 1000);
  await flush();
}

test('sync refreshes immediately and then at the configured interval', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    });

    poller.sync(900);
    assert.equal(calls, 1, 'the user must not wait a full interval for the first values');

    await advance(900);
    await advance(900);
    assert.equal(calls, 3);

    poller.stop();
  });
});

test('sync is a no-op when the interval did not change', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    });

    poller.sync(900);
    // A reconnection re-syncs with the same value: re-reading the API here
    // would burn quota for nothing.
    poller.sync(900);
    poller.sync(900);
    assert.equal(calls, 1);

    poller.stop();
  });
});

test('sync applies a new interval right away', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    });

    poller.sync(900);
    await flush();
    poller.sync(300);
    assert.equal(calls, 2, 'changing the interval is an explicit user action: refresh now');
    assert.equal(poller.intervalSeconds, 300);

    await advance(300);
    assert.equal(calls, 3, 'the old 900 s timer must not survive');

    poller.stop();
  });
});

test('stop cancels the loop', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    });

    poller.sync(900);
    poller.stop();
    assert.equal(poller.intervalSeconds, null);

    await advance(900 * 10);
    assert.equal(calls, 1, 'no tick after stop');
  });
});

test('a failing refresh does not kill the loop', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw new Error('Electricity Maps is down');
    });

    poller.sync(900);
    await advance(900);
    assert.equal(calls, 2, 'a transient API failure must not stop the refreshes for good');

    poller.stop();
  });
});

test('a tick landing on a still-running refresh is dropped', async () => {
  await withFakeTimers(async () => {
    let started = 0;
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const poller = createPoller(async () => {
      started += 1;
      await blocked;
    });

    poller.sync(900);
    assert.equal(started, 1);

    await advance(900);
    await advance(900);
    assert.equal(started, 1, 'two refreshes must never overlap');

    release();
    await flush();

    await advance(900);
    assert.equal(started, 2, 'the loop resumes once the slow refresh is over');

    poller.stop();
  });
});

test('refreshNow refreshes without disturbing the schedule', async () => {
  await withFakeTimers(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
    });

    poller.sync(900);
    await flush();
    // The user pasted their token: the interval did not change, but waiting
    // 900 s in front of empty sensors is not acceptable.
    await poller.refreshNow();
    assert.equal(calls, 2);
    assert.equal(poller.intervalSeconds, 900, 'the schedule is untouched');

    await advance(900);
    assert.equal(calls, 3);

    poller.stop();
  });
});

test('sync reports whether it restarted the loop', async () => {
  await withFakeTimers(async () => {
    const poller = createPoller(async () => {});

    assert.equal(poller.sync(900), true, 'first start');
    assert.equal(poller.sync(900), false, 'same interval: nothing to do');
    assert.equal(poller.sync(300), true, 'new interval');

    poller.stop();
  });
});
