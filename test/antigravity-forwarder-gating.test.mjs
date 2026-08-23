import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Antigravity forwarder used to be spawned unconditionally on a fixed
// 127.0.0.1:4212. A forwarder that cannot listen exits, and an unconditional
// health wait turns that exit into a failed startup -- so one process holding
// that port took down the gateway, the router, the API forwarder and both
// other OAuth forwarders, for an operator who had never signed in to
// Antigravity. The stored session is the gate now, and these cases drive the
// real start.mjs to prove it.
//
// Unlike Devin, the gate cannot be the curated model: Antigravity's models are
// checked in, so `MODELS` names the provider on every install. Sign-in is what
// makes those models reachable -- `providers enable antigravity-oauth` refuses
// to run before it -- so the credential is the equivalent answer here.
//
// `MODEL_ROUTER_LITELLM_BIN` points at node, which exits immediately when
// handed LiteLLM's arguments, so startup always fails at the gateway: the
// stage *after* the forwarders. "Reached the gateway" is therefore a positive
// assertion that the forwarder stage completed. Same trick as
// devin-forwarder-gating.test.mjs and startup-cleanup.test.mjs.

// See startup-cleanup.test.mjs: progress, not elapsed time, separates a slow
// machine from a stuck one, so the watchdog fires only on silence.
const STARTUP_STALL_MS = 30_000;

function waitForStartupExit(child, readErrors) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let lastOutput = started;
    const onProgress = () => {
      lastOutput = Date.now();
    };
    child.stderr.on("data", onProgress);
    const finish = () => {
      clearInterval(watchdog);
      child.stderr.off("data", onProgress);
    };
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastOutput;
      if (idleMs < STARTUP_STALL_MS) return;
      finish();
      reject(
        new Error(
          `startup stalled: no output for ${idleMs} ms after waiting ${Date.now() - started} ms in total; stderr so far:\n${readErrors()}`,
        ),
      );
    }, 250);
    child.once("exit", (code, signal) => {
      finish();
      resolve({ code, signal });
    });
  });
}

// Holds a port so a forwarder that tries to bind it fails with EADDRINUSE.
// Occupying it is how "nothing was spawned" is proved positively: an unspawned
// forwarder cannot collide with the squatter, so startup walks past it.
async function squat(port) {
  const server = net.createServer();
  // Hang up on anything that connects, so a probe of this port fails the way a
  // dead listener does rather than waiting for a response that never comes.
  server.on("connection", (socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `the test could not hold 127.0.0.1:${port} for the Antigravity forwarder to collide with: ${error.code || error.message}`,
          { cause: error },
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    listening: () => server.listening,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.unref();
      }),
  };
}

async function runStartup({ signedIn = false, occupyAntigravityPort = false } = {}) {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, antigravityPort] = ports;

  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-antigravity-gate-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "internal-secret"),
    "antigravity-gate-internal-key-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "antigravity-gate-caller-key-with-sufficient-length\n",
    { mode: 0o600 },
  );
  if (signedIn) {
    // The same shape `saveAntigravityToken` writes, held to whatever
    // `validateAntigravityToken` accepts: the gate reads the credential
    // through `antigravityOAuthStatus()`, so a file it would reject proves
    // nothing about a session that exists.
    writeFileSync(
      path.join(stateDir, "antigravity-oauth.json"),
      `${JSON.stringify({
        access_token: "antigravity-gate-access-token",
        refresh_token: "antigravity-gate-refresh-token",
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        expires_in: 3_600,
        project_id: "gate-test-project",
        project_source: "managed",
      })}\n`,
      { mode: 0o600 },
    );
  }

  const squatter = occupyAntigravityPort ? await squat(antigravityPort) : undefined;

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(antigravityPort),
      MODEL_ROUTER_LITELLM_BIN: process.execPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const exit = await waitForStartupExit(child, () => errors);
    // Read the squatter before the teardown below closes it.
    return {
      exit,
      errors,
      antigravityPort,
      squatterHeldPort: squatter ? squatter.listening() : undefined,
    };
  } finally {
    // start.mjs re-creates directories under `stateDir` while it winds down, so
    // removing the tree before it is gone races its own teardown.
    await stopChild(child);
    if (squatter) await squatter.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

// SIGTERM is not a signal on Windows: Node emulates it with TerminateProcess,
// so a process that is already exiting may never be reachable. Fall back to
// SIGKILL rather than waiting out a run.
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let hardStop;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      hardStop = setTimeout(resolve, 5_000);
    }),
  ]);
  clearTimeout(hardStop);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

test(
  "an install with no Antigravity session spawns no forwarder and binds no port",
  { timeout: 120_000 },
  async () => {
    // The Antigravity port is held by this test. A forwarder that was spawned
    // would die on EADDRINUSE and abort startup by name, so reaching the
    // gateway failure instead is proof that nothing was spawned.
    const { exit, errors, squatterHeldPort } = await runStartup({ occupyAntigravityPort: true });

    assert.doesNotMatch(errors, /\[antigravity-oauth\]/, errors);
    assert.doesNotMatch(errors, /Antigravity OAuth forwarder/, errors);
    assert.match(errors, /startup failed: LiteLLM gateway exited before becoming healthy\./, errors);
    assert.equal(exit.code, 1, errors);
    assert.equal(squatterHeldPort, true, "something took the Antigravity port from this test");
  },
);

test(
  "a stored Antigravity session spawns the forwarder and waits on its health",
  { timeout: 120_000 },
  async () => {
    const { exit, errors } = await runStartup({ signedIn: true });

    // The forwarder announces itself when its listener is up, and startup only
    // reaches the gateway once every forwarder health wait has resolved -- so
    // both halves of "spawned and waited on" are asserted.
    assert.match(errors, /\[antigravity-oauth\] listening/, errors);
    assert.match(errors, /startup failed: LiteLLM gateway exited before becoming healthy\./, errors);
    assert.equal(exit.code, 1, errors);
  },
);

test(
  "a stored Antigravity session that cannot bind its port still fails startup by name",
  { timeout: 120_000 },
  async () => {
    // Gating must not turn a real failure into a silent skip: once the provider
    // is signed in, an unbindable forwarder aborts startup naming itself,
    // exactly as it did when the spawn was unconditional.
    const { exit, errors } = await runStartup({ signedIn: true, occupyAntigravityPort: true });

    assert.match(
      errors,
      /startup failed: Antigravity OAuth forwarder exited before becoming healthy\./,
      errors,
    );
    assert.doesNotMatch(errors, /LiteLLM gateway exited before becoming healthy/, errors);
    // Non-zero rather than exactly 1: on Windows a failed startup can abort in
    // libuv teardown with 0xC0000409 after naming the failure correctly, so the
    // exit code is unreliable there (#370). What this test is about is that the
    // gate does not turn a real failure into a silent skip, and the named error
    // above proves that. Asserting the precise code would couple this test to a
    // pre-existing teardown bug it is not exercising -- the same bug that makes
    // devin-forwarder-gating.test.mjs flake on windows-latest.
    assert.notEqual(exit.code, 0, errors);
  },
);

test("no stored token value is echoed while the gate is being decided", { timeout: 120_000 }, async () => {
  const { errors } = await runStartup({ signedIn: true });
  assert.doesNotMatch(errors, /antigravity-gate-access-token/);
  assert.doesNotMatch(errors, /antigravity-gate-refresh-token/);
  assert.doesNotMatch(errors, /antigravity-gate-internal-key-with-sufficient-length/);
});
