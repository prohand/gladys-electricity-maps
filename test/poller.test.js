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

test('refreshNow during a running refresh reads once more right after it', async () => {
  let calls = 0;
  let release;
  const poller = createPoller(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  });
  const running = poller.refreshNow();
  await Promise.resolve();
  // A new token is saved while the first read is still waiting on the API.
  const first = poller.refreshNow();
  const second = poller.refreshNow();
  release();
  await Promise.all([running, first, second]);
  assert.equal(calls, 2, 'one follow-up read, shared by both callers');
});

/** Same as withFakeTimers, with the retry timer and the clock faked too. */
async function withFakeClock(fn) {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
}

/** The error src/electricityMaps.js throws when the API was not reached. */
function unreachable() {
  return Object.assign(new Error('Electricity Maps unreachable: getaddrinfo EAI_AGAIN'), {
    status: 0,
  });
}

test('refreshNow hands the failure of the read to its caller', async () => {
  // A scene action ticking "Refresh first" must not be served the previous
  // reading as if it had just been taken.
  const poller = createPoller(async () => {
    throw new Error('Electricity Maps HTTP 500');
  });
  await assert.rejects(() => poller.refreshNow(), /HTTP 500/);
});

test('a refreshNow queued behind a running read gets its own failure', async () => {
  let calls = 0;
  let release;
  const poller = createPoller(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
      return;
    }
    throw new Error('second read failed');
  });
  const running = poller.refreshNow();
  await Promise.resolve();
  const queued = poller.refreshNow();
  release();
  await running;
  await assert.rejects(() => queued, /second read failed/);
});

test('a scheduled tick stays silent when its read fails', async () => {
  await withFakeTimers(async () => {
    const poller = createPoller(async () => {
      throw new Error('down');
    });
    // Would be an unhandled rejection (and fail the run) if it leaked.
    poller.sync(900);
    await flush();
    await advance(900);
    poller.stop();
  });
});

test('an unreachable API is retried after one minute, then five, then left to the tick', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw unreachable();
    });

    poller.sync(3600);
    assert.equal(calls, 1);

    await advance(59);
    assert.equal(calls, 1, 'not before the minute');
    await advance(1);
    assert.equal(calls, 2, 'first retry after 60 s');

    await advance(300);
    assert.equal(calls, 3, 'second retry 5 minutes later');

    await advance(3600 - 360 - 1);
    assert.equal(calls, 3, 'no third retry: the budget is spent');
    await advance(1);
    assert.equal(calls, 4, 'the scheduled tick reads again');

    poller.stop();
  });
});

test('a retry stops as soon as a read succeeds', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      if (calls === 1) {
        throw unreachable();
      }
    });

    poller.sync(3600);
    await advance(60);
    assert.equal(calls, 2, 'the network came back: the retry read it');
    await advance(300);
    assert.equal(calls, 2, 'nothing more until the next tick');

    poller.stop();
  });
});

test('a retry that would land after the next tick is left to that tick', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw unreachable();
    });

    poller.sync(300);
    await advance(60);
    assert.equal(calls, 2, 'the 60 s retry fits before the 300 s tick');
    await advance(240);
    assert.equal(calls, 3, 'the tick, not a second retry at 360 s');
    await advance(60);
    assert.equal(calls, 4, 'the tick starts its own retry budget');

    poller.stop();
  });
});

test('a refused token is not retried before the next tick', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw Object.assign(new Error('Invalid API token'), { status: 401 });
    });

    poller.sync(3600);
    await advance(3599);
    assert.equal(calls, 1, 'a 401 fails the same way a minute later');

    poller.stop();
  });
});

test('a 429 is retried when Retry-After says so, and nothing reads before', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('quota'), { status: 429, retryAfterSeconds: 600 });
      }
    });

    poller.sync(3600);
    await flush();
    await assert.rejects(() => poller.refreshNow(), /asked to wait/);
    assert.equal(calls, 1, 'an explicit refresh does not hammer a 429 either');

    await advance(599);
    assert.equal(calls, 1);
    await advance(1);
    assert.equal(calls, 2, 'read again once the wait is over');

    poller.stop();
  });
});

test('a 429 without Retry-After waits for the next tick', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw Object.assign(new Error('quota'), { status: 429, retryAfterSeconds: null });
    });

    poller.sync(900);
    await advance(899);
    assert.equal(calls, 1);
    await advance(1);
    assert.equal(calls, 2);

    poller.stop();
  });
});

test('stop cancels a pending retry', async () => {
  await withFakeClock(async () => {
    let calls = 0;
    const poller = createPoller(async () => {
      calls += 1;
      throw unreachable();
    });

    poller.sync(3600);
    await flush();
    poller.stop();
    await advance(600);
    assert.equal(calls, 1);
  });
});
