import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The router meters after it has already answered the client, so the request
// can resolve before the event reaches disk. Poll rather than sleep.
async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// Read the routed turn with the raw client so a socket reset stays
// distinguishable from a complete message. A reset mid-chunked-body leaves
// `response.complete` false, which is the transport failure a reqwest client
// reports as "error decoding response body".
function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({ status: response.statusCode, body: text, complete: response.complete });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

// A gateway that dies partway through an SSE body used to reach the client as a
// bare socket reset: `.pipe()` never forwarded the error, so the response stayed
// half-written until the top-level handler destroyed it, and the log said only
// "[codex-router] request failed".
test("a gateway that dies mid-stream ends the routed body and logs the cause", async () => {
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    response.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    );
    // Reset the upstream socket without the terminating chunk, exactly as an
    // edge that drops a live stream does.
    setTimeout(() => response.destroy(), 60);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, {
      model: "deepseek/deepseek-v4-pro",
      input: "hello",
      stream: true,
    });

    assert.equal(result.status, 200);
    assert.equal(
      result.complete,
      true,
      "the chunked body was reset instead of reaching its terminator",
    );
    // What the upstream managed to send survives, and the failure is stated
    // rather than passed off as a short successful turn.
    assert.match(result.body, /event: response\.created/);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /local_router_stream_failed/);
    // The terminal event is the only place a cause can still reach the client
    // once the head is committed. Without it Codex reports a stream that just
    // stopped as `stream disconnected before completion`, which names nothing.
    assert.match(result.body, /closed early|reset the connection/);

    // The log has to name the cause; the bare string it used to write is why
    // this was undiagnosable in production.
    // A wait, not a bound: nothing here is asserting how *fast* the router
    // logs, only that it does, and 2s was short enough that a loaded machine
    // could still be scheduling the write. Wait as long as the rest of this
    // file waits for anything else. A router that never logs the cause still
    // fails on the assertion below, which is the property under test.
    const deadline = Date.now() + 10_000;
    while (!/request failed: /.test(router.testErrors()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(router.testErrors(), /\[codex-router\] request failed: \w+: .+/);

    // The turn is truncated, not successful: the meter must record a failure
    // carrying the abort marker instead of the committed 200 the client
    // never finished reading.
    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.model, "deepseek/deepseek-v4-pro");
    assert.equal(event.provider, "deepseek");
    assert.equal(event.status, 502);
    assert.equal(event.streamAborted, true);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

// A client that cancels mid-stream is not an upstream failure: the router
// meters the turn as 0 rather than the committed 200 or a fabricated 5xx.
test("a client cancel mid-stream meters 0 and never claims an upstream failure", async () => {
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    // Hold the stream open; the client is the one leaving.
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    // Read with the raw client so the cancel is a real socket hangup, the
    // same path Codex uses when the user stops a generation.
    await new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: `${callerBaseUrl(routerPort, CALLER_KEY)}/responses`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer codex-caller-auth",
          },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", resolve);
      request.end(
        JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello", stream: true }),
      );
    });

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.model, "deepseek/deepseek-v4-pro");
    assert.equal(event.status, 0);
    assert.equal("streamAborted" in event, false);
    // No 502 marker and no failure log: the cancel was never an upstream
    // error, so it must not push the error state either.
    assert.doesNotMatch(router.testErrors(), /request failed/);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

// A bare `listen()` failure is an unhandled 'error' event: the process exits
// silently, the supervisor restarts it, and the port is never bound with
// nothing in the log to say why.
test("a taken port exits with a named cause and a distinguishable code", async () => {
  const holder = net.createServer();
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", resolve);
  });
  const takenPort = holder.address().port;
  const router = run({ CODEX_ROUTER_PORT: String(takenPort) });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("router never exited")), 10_000);
      router.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 98);
    assert.match(router.testErrors(), /cannot listen: 127\.0\.0\.1:\d+ is already in use/);
  } finally {
    await stopChild(router);
    await new Promise((resolve) => holder.close(resolve));
  }
});

// The router must keep answering /health and keep routing when the selection
// file names a provider this build does not have; that read used to throw out
// of the first statement of healthPayload().
test("a selection file naming an unknown provider does not wedge the router", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-selection-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({
      version: 1,
      providers: ["deepseek", "provider-from-a-newer-build"],
    })}\n`,
    { mode: 0o600 },
  );
  const gateway = await mockServer((request, response) => {
    const payload = Buffer.from(JSON.stringify({ ok: true, route: "external" }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // The known provider in the same file still routes.
    const routed = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer codex-caller-auth",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello" }),
    });
    assert.equal(routed.status, 200);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Codex's HTTP client pools idle connections for 90 seconds and ignores the
// `Keep-Alive: timeout=` header the router advertises, so Node's 5-second
// default made the server close sockets the client still believed were live.
// Reusing one of those answered the next turn with a FIN instead of a
// response, which reqwest reports as "error sending request for url" and
// Codex surfaces as "stream disconnected before completion". The idle gap
// here is longer than that old default and shorter than the pool it has to
// outlast.
test("an idle keep-alive connection survives past Node's default timeout", async () => {
  const gateway = await mockServer((request, response) => {
    const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const IDLE_MS = 6_500;

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);

    const socket = net.connect(routerPort, "127.0.0.1");
    try {
      const request =
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n";
      // A raw socket is the only way to hold one connection across the idle
      // gap; an agent would be free to open a second one and hide the bug.
      const exchange = () =>
        new Promise((resolve, reject) => {
          let text = "";
          const onData = (chunk) => {
            text += chunk.toString("utf8");
            if (text.includes("\r\n\r\n") && text.trimEnd().endsWith("}")) done(resolve, text);
          };
          const onEnd = () =>
            done(reject, undefined, new Error("server closed the idle connection"));
          const onError = (error) => done(reject, undefined, error);
          function done(settle, value, error) {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            clearTimeout(timer);
            error ? settle(error) : settle(value);
          }
          const timer = setTimeout(
            () => done(reject, undefined, new Error("no response on the reused connection")),
            5_000,
          );
          socket.on("data", onData);
          socket.once("end", onEnd);
          socket.once("error", onError);
          socket.write(request);
        });

      const first = await exchange();
      assert.match(first, /^HTTP\/1\.1 200/);
      // The advertised timeout is what a client that does read the header
      // (undici, curl) paces itself by, so it has to move with the setting.
      assert.match(first, /Keep-Alive: timeout=120/);

      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      assert.equal(
        socket.destroyed,
        false,
        `the router closed an idle connection within ${IDLE_MS}ms`,
      );

      const second = await exchange();
      assert.match(second, /^HTTP\/1\.1 200/);
    } finally {
      socket.destroy();
    }
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});
