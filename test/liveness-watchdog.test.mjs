import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FAILURES_BEFORE_RESTART,
  livenessLimits,
  probeLiveness,
  stopUnresponsive,
  watchLiveness,
} from "../src/liveness-watchdog.mjs";

// The process this stands in for is the one the watchdog exists for: alive,
// so nothing it does resolves a `waitForExit`, and unreachable, so every
// client request fails. `kill` is recorded rather than acted on unless the
// fake is told to honour it.
function fakeChild({ honoursSignals = true } = {}) {
  const child = { exitCode: null, signalCode: null, killed: [] };
  child.kill = (signal) => {
    child.killed.push(signal);
    if (!honoursSignals) return;
    if (signal === "SIGKILL") child.signalCode = signal;
    else child.signalCode = signal;
  };
  return child;
}

function harness({
  answers,
  failuresBeforeRestart = DEFAULT_FAILURES_BEFORE_RESTART,
  child = fakeChild(),
} = {}) {
  const logs = [];
  const probes = [];
  const queue = [...answers];
  const watcher = watchLiveness({
    label: "Codex router",
    child,
    failuresBeforeRestart,
    // The script is the child's whole life: each probe is answered from it, and
    // running off the end stands in for the process exiting, which is the only
    // other way this loop ends.
    probe: async () => {
      if (queue.length === 0) {
        child.exitCode = 0;
        return true;
      }
      const next = queue.shift();
      probes.push(next);
      return next;
    },
    sleep: async () => {},
    log: (message) => logs.push(message),
  });
  return { child, logs, probes, watcher, remaining: () => queue.length };
}

test("a child that keeps answering is never stopped", async () => {
  const { child, watcher, probes } = harness({ answers: [true, true, true, true, true] });
  // Nothing trips, so the loop only ends when the child does.
  const result = await watcher.done;
  assert.equal(result.tripped, false);
  assert.deepEqual(child.killed, []);
  assert.deepEqual(probes, [true, true, true, true, true]);
});

test("consecutive misses stop the child, and one answer resets the count", async () => {
  const { child, logs, watcher } = harness({
    // Three misses, an answer, then a full run of four.
    answers: [false, false, false, true, false, false, false, false],
    failuresBeforeRestart: 4,
  });

  const result = await watcher.done;
  assert.equal(result.tripped, true);
  assert.equal(result.misses, 4);
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.match(logs.join("\n"), /answering its liveness probe again after 3 miss/);
  assert.match(logs.join("\n"), /alive but not serving/);
});

test("a single miss is not enough to restart anything", async () => {
  const { child, watcher, logs } = harness({ answers: [false, true, true], failuresBeforeRestart: 4 });
  const result = await watcher.done;
  assert.equal(result.tripped, false);
  assert.deepEqual(child.killed, []);
  assert.match(logs.join("\n"), /did not answer its liveness probe \(1 of 4/);
});

test("cancelling ends the watch without touching the child", async () => {
  const { child, watcher } = harness({ answers: [false, false, false, false] });
  watcher.cancel();
  const result = await watcher.done;
  assert.equal(result.tripped, false);
  assert.deepEqual(child.killed, []);
});

test("failuresBeforeRestart=0 disables the watchdog", async () => {
  const { child, watcher, probes } = harness({
    answers: [false, false, false, false, false],
    failuresBeforeRestart: 0,
  });
  const result = await watcher.done;
  assert.deepEqual(result, { tripped: false, disabled: true });
  assert.deepEqual(probes, []);
  assert.deepEqual(child.killed, []);
});

// The distinction the whole design rests on. The router answers 503 whenever
// the gateway is unreachable, so treating a status as evidence would restart
// the router every time a provider was down.
test("any HTTP answer counts as alive; only a thrown probe does not", async () => {
  const answered = await probeLiveness({
    url: "http://127.0.0.1:1/health",
    fetchImpl: async () => ({ status: 503, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(answered, true);

  const refused = await probeLiveness({
    url: "http://127.0.0.1:1/health",
    fetchImpl: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  });
  assert.equal(refused, false);
});

test("a probe that never answers is a miss rather than a hang", async () => {
  // `AbortSignal.timeout` runs on an unref'd timer, so nothing but this holds
  // the loop open while a stalled probe waits out its window. The service has
  // a listening server and a ref'd sleep doing that job; a test has neither.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const answered = await probeLiveness({
      url: "http://127.0.0.1:1/health",
      timeoutMs: 10,
      fetchImpl: (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    assert.equal(answered, false);
  } finally {
    clearTimeout(keepAlive);
  }
});

// A wedged process cannot run its SIGTERM handler, and the router's handler
// waits for in-flight requests even when it can. Without the escalation the
// supervisor would park on an exit that never arrives.
test("a child that ignores SIGTERM is killed after the grace period", async () => {
  const child = fakeChild({ honoursSignals: false });
  const logs = [];
  stopUnresponsive(child, { graceMs: 1, log: (message) => logs.push(message) });
  assert.deepEqual(child.killed, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  assert.match(logs.join("\n"), /SIGKILL/);
});

test("a child that stops on SIGTERM is not killed afterwards", async () => {
  const child = fakeChild();
  stopUnresponsive(child, { graceMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("the limits are read from the environment, and zero disables", () => {
  assert.deepEqual(
    livenessLimits({
      CODEX_ROUTER_LIVENESS_INTERVAL_MS: "1000",
      CODEX_ROUTER_LIVENESS_TIMEOUT_MS: "250",
      CODEX_ROUTER_LIVENESS_FAILURES: "2",
    }),
    { intervalMs: 1000, timeoutMs: 250, failuresBeforeRestart: 2 },
  );
  assert.equal(livenessLimits({ CODEX_ROUTER_LIVENESS_FAILURES: "0" }).failuresBeforeRestart, 0);
  // Nonsense falls back rather than disabling supervision by accident.
  assert.equal(
    livenessLimits({ CODEX_ROUTER_LIVENESS_FAILURES: "nope" }).failuresBeforeRestart,
    DEFAULT_FAILURES_BEFORE_RESTART,
  );
});
