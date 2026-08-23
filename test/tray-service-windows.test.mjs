import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Windows tray manager can only be exercised off-Windows through its
// render commands, the same contract service-windows.mjs uses: everything that
// touches Task Scheduler refuses to run on the wrong platform, and everything
// that only renders a definition works anywhere so CI can check it.
function trayService(command, { platform = "win32", env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service-windows.mjs"), command],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: platform, ...env },
    },
  );
}

function trayDispatch(command, platform) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service.mjs"), command],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: platform },
    },
  );
}

test("the registered action points at the Tauri release binary", () => {
  const result = trayService("render-task");
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout);
  assert.ok(action.execute.endsWith("codex-router-desktop.exe"), action.execute);
  assert.ok(action.execute.includes(path.join("src-tauri", "target", "release")), action.execute);
  // A GUI binary takes no arguments; the router's task needs them, this one
  // must not inherit that shape.
  assert.equal(action.argument, "");
});

test("a render resolves the path for the platform it is rendering for", () => {
  // Not process.platform: a render on Linux still has to show the .exe that
  // would actually be registered on Windows.
  assert.match(JSON.parse(trayService("render-task").stdout).execute, /\.exe$/);
});

test("Task Scheduler commands refuse to run off Windows", () => {
  for (const command of ["install", "uninstall", "start", "stop", "restart", "status"]) {
    const result = trayService(command, { platform: "linux" });
    assert.notEqual(result.status, 0, `${command} should have refused`);
    assert.match(result.stderr, /runs on Windows only/);
  }
});

test("an unknown subcommand exits 2 with usage", () => {
  const result = trayService("frobnicate");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: tray-service-windows\.mjs/);
});

test("install refuses before the tray has been built", () => {
  // The checkout under test has no compiled Tauri binary, so this exercises
  // the real guard rather than a stub. A missing binary must name the build
  // command instead of registering a task that points at nothing.
  const result = trayService("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not built at/);
  assert.match(result.stderr, /build-desktop-tray\.ps1/);
});

test("the dispatcher routes Windows to the Task Scheduler manager", () => {
  // Windows reached the no-op branch before this existed, so `control tray
  // enable` printed {"supported":false} and exited 0 -- success, with no tray.
  const result = trayDispatch("status", "win32");
  assert.doesNotMatch(result.stdout, /"supported":false/);
});

test("tray restarts wait for Task Scheduler to stop before starting again", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /function waitForTaskState\(/);
  assert.match(source, /timeout: options\.timeoutMs \|\| TASK_COMMAND_TIMEOUT_MS/);
  assert.match(source, /const probeTimeout = Math\.min\(TASK_COMMAND_TIMEOUT_MS, remaining\)/);
  assert.match(source, /Register-ScheduledTask[\s\S]*?timeout: TASK_COMMAND_TIMEOUT_MS/);
  assert.match(source, /endTask\(\)[\s\S]*?waitForTaskState\([^\n]+TASK_STOP_TIMEOUT_MS/);
  assert.match(source, /function startTask\(\)[\s\S]*?waitForTaskState\([^\n]+TASK_START_TIMEOUT_MS/);
  assert.doesNotMatch(source, /if \(command === "restart"\) endTask\(\);\s*\n\s*schtasks\(\["\/Run"/);
});

test("tray uninstall verifies that Task Scheduler removed the task", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const uninstall = source.slice(
    source.indexOf('command === "uninstall"'),
    source.indexOf('command === "stop"'),
  );
  assert.match(uninstall, /schtasks\(\["\/Delete"/);
  // A task the scheduler still cannot enumerate must fail the uninstall, never
  // report success as "missing".
  assert.match(uninstall, /if \(taskExists\(\) === "exists"\)[\s\S]*?throw/);
  assert.match(uninstall, /if \(existence === "error"\)[\s\S]*?did not answer whether the tray task was removed/);
  assert.doesNotMatch(uninstall, /catch \{\s*\/\/ The task may not exist/);
  // endTask() can throw when the scheduler is unreadable; that must not block
  // the /Delete attempt that is the actual uninstall.
  assert.match(uninstall, /catch \{[\s\S]*?Best effort stop/);
  const endTaskTry = uninstall.indexOf("try {");
  const endTaskCall = uninstall.indexOf("endTask()");
  const deleteCall = uninstall.indexOf('schtasks(["/Delete"');
  assert.ok(
    endTaskTry >= 0 && endTaskCall > endTaskTry && endTaskCall < deleteCall,
    "endTask must be isolated so /Delete always runs",
  );
});

test("task query returns a tri-state answer, not a silent false", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const task = source.slice(
    source.indexOf("function taskExists("),
    source.indexOf("function sleep("),
  );
  // The positive, negative, and indeterminate outcomes are returned as distinct
  // literals rather than collapsed to a boolean false.
  assert.match(task, /return sawError \? "error" : "missing"/);
  assert.match(task, /"exists"/);
  assert.match(task, /"missing"/);
  // Only the culture-invariant "task not found" FullyQualifiedErrorId may count
  // as missing; a timeout/denial/scheduler outage must become "error".
  assert.match(task, /CmdletizationQuery_NotFound_TaskName/);
  // Both PowerShell hosts are consulted before a host failure is treated as
  // indeterminate rather than as an absent task.
  assert.match(task, /for \(const executable of \["powershell\.exe", "pwsh\.exe"\]\)/);
});

test("a scheduler failure is never treated as a missing task while stopping", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const wait = source.slice(
    source.indexOf("function waitForTaskState("),
    source.indexOf("function endTask("),
  );
  assert.match(wait, /existence === "missing"/);
  assert.match(wait, /if \(action === "stop"\) return "missing"/);
  // An indeterminate query is reported, not swallowed into a "missing" answer.
  assert.match(wait, /existence === "error"[\s\S]*?did not answer/);
  assert.match(wait, /uninstall would report[\s\S]*?success it did not earn/);
});

test("tray status reports the registered action and reads task state once", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /function registeredTaskAction\(/);
  assert.match(source, /const action = installed \? registeredTaskAction\(\) : undefined/);
  assert.match(source, /const companionPath = action\?\.execute/);
  assert.match(source, /const taskStatus = installed \? taskState\(\) : undefined/);
  assert.doesNotMatch(source, /loaded: installed && taskRunning\(\)/);
});

test("status stays a JSON exit-0 document when Task Scheduler is unreadable", () => {
  // With no scheduler hosts reachable (empty PATH forces both PowerShell
  // hosts to fail), taskExists() returns "error" and status must print
  // parseable JSON and exit 0. It used to throw, which emptied stdout and
  // broke every caller that parses status JSON.
  const result = trayService("status", { env: { PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.supported, true);
  assert.equal(doc.state, "unknown");
  assert.equal(doc.loaded, false);
  assert.match(result.stdout, /"why":/);
});

test("tray mutations are guarded so a test run never touches the scheduler", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /skipServiceManagerCall/);
  assert.match(source, /const HOST_MANAGED = process\.platform === "win32"/);
  // Queries stay live while every scheduler mutation consults the guard.
  assert.match(source, /if \(options\.mutating && skipServiceManagerCall/);
  assert.match(source, /function installTask\([\s\S]*?skipServiceManagerCall/);
  assert.match(source, /function endTask\(\)[\s\S]*?skipServiceManagerCall/);
  assert.match(source, /function startTask\(\)[\s\S]*?skipServiceManagerCall/);
  // /End, /Run and /Delete are the three direct writes through schtasks; all
  // three must be marked mutating so the guard can skip them under test.
  assert.match(source, /\/End"[\s\S]*?mutating: true/);
  assert.match(source, /\/Run"[\s\S]*?mutating: true/);
  assert.match(source, /\/Delete"[\s\S]*?mutating: true/);
});

test("tray Task Scheduler timeouts match service-windows.mjs's single larger value", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /const TASK_COMMAND_TIMEOUT_MS = 15_000;/);
  // The windows service manager uses 15_000 for the identical Get-ScheduledTask
  // read, so the tray must not abort install/start/restart/uninstall on a slow
  // cold-start powershell the way a 4 s budget did. The per-host split still
  // keeps each PowerShell host within its share.
  assert.match(source, /const perHostTimeout = Math\.max\(50, Math\.floor\(timeoutMs \/ 2\)\)/);
});

test("tray registration leaves its interactive principal able to update the task", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /WindowsIdentity\]\:\:GetCurrent\(\)\.User\.Value/);
  assert.match(source, /GetSecurityDescriptor\(7\)/);
  assert.match(source, /RawSecurityDescriptor/);
  assert.match(source, /TASK_FULL_CONTROL_MASK\s*=\s*0x1f01ff/);
  assert.match(source, /DiscretionaryAcl\.InsertAce/);
  assert.match(source, /SetSecurityDescriptor\([^\n]+0x10\)/);
  assert.match(source, /earlier elevated install owns it[\s\S]*?tray repair/);
  assert.doesNotMatch(source, /icacls|takeown/i);
});

test("a platform with no supervisor says so instead of reporting success", () => {
  const result = trayDispatch("install", "linux");
  assert.equal(result.status, 0, "an install must not fail over an unsupervised companion");
  assert.match(result.stdout, /"supported":false/);
  assert.match(result.stderr, /not supervised on linux/);
  // `status` is machine-readable and stays quiet.
  assert.equal(trayDispatch("status", "linux").stderr, "");
});

// macOS and Linux each have one command that builds the companion and hands it
// to a supervisor. Windows had none: bin/model-router-tray told you to go read
// a build script, and codex-router.ps1 had no tray verb at all, so the only
// route was knowing two separate incantations.
test("the Windows CLI exposes tray as a first-class command", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"refresh-catalog", "media", "tray"/);
  assert.match(script, /"tray" \{/);
  // Build only when the sources moved, then stamp it, then register.
  assert.match(script, /install-plan\.mjs"\) tray-plan/);
  assert.match(script, /build-desktop-tray\.ps1"\) -BinaryOnly/);
  assert.match(script, /install-plan\.mjs"\) record-tray/);
  assert.match(script, /tray-service\.mjs" @\(\$Action\)/);
  // Every action the supervisor accepts is reachable.
  for (const action of ["install", "status", "start", "stop", "restart", "uninstall"]) {
    assert.ok(script.includes(`"${action}"`), `tray action ${action} is unreachable`);
  }
});

test("tray rebuild registers the artifact it just built", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const rebuild = script.slice(
    script.indexOf('if ($Action -eq "rebuild")'),
    script.indexOf('if ($Action -eq "install" -and'),
  );
  assert.match(rebuild, /tray-service\.mjs" @\("install"\)/);
  assert.match(rebuild, /tray-service\.mjs" @\("install-electron"\)/);
  assert.doesNotMatch(rebuild, /tray-service\.mjs" @\("restart"\)/);
  // Windows locks running tray binaries, so the supervised task is stopped
  // BEFORE the in-place build, and a failed rebuild restores the old instance.
  const stopBeforeBuild = rebuild.indexOf('tray-service.mjs" @("stop")');
  const build = rebuild.indexOf("build-desktop-tray.ps1");
  assert.ok(stopBeforeBuild >= 0 && stopBeforeBuild < build,
    "the running tray must be stopped before the in-place build");
  assert.match(rebuild, /\$TrayWasRunning\s*=\s*\$/);
  assert.match(rebuild, /tray-service\.mjs" @\("start"\)/);
  assert.match(rebuild, /Companion rebuild failed/);
});

test("PowerShell children that emit parsed text pin their output encoding to UTF-8", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  // OEM-encoded Console.Out corrupts a localized profile path before Node's
  // `encoding: "utf8"` sees it, which made status report appPresent:false on a
  // healthy tray and reject a valid deploy.
  const pin = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";
  const pinWithin = (functionName) => {
    const start = source.indexOf(`function ${functionName}(`);
    assert.ok(start >= 0, `${functionName} must still exist`);
    // Every PowerShell child that writes text for Node to parse pins UTF-8
    // near the top of its script body, before emitting the parsed output.
    return source.slice(start, start + 900).includes(pin);
  };
  assert.ok(pinWithin("taskState"), "taskState must pin UTF-8 before its output");
  assert.ok(pinWithin("registeredTaskAction"), "registeredTaskAction must pin UTF-8");
  assert.ok(pinWithin("taskExists"), "taskExists must pin UTF-8");
});

test("tray repair validates the task and grants only its current principal control", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"repair"/);
  assert.match(script, /function Get-ValidatedTrayTask/);
  assert.match(script, /principal is not the current user/);
  // A task registered from another checkout must still be recognized by shape,
  // so a dev user whose task points at %LOCALAPPDATA% is not rejected.
  assert.doesNotMatch(script, /this checkout's tray companion/);
  assert.match(script, /not a Codex Router tray companion/);
  assert.match(script, /RawSecurityDescriptor/);
  assert.match(script, /SetSecurityDescriptor\([^\n]+0x10\)/);
  // The elevated PowerShell host must be named absolutely so ShellExecuteEx
  // cannot resolve a CWD/PATH shadow, and the working directory pinned to
  // SystemRoot so the elevated child runs from an unwritable directory.
  assert.match(script, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(script, /Start-Process[^\n]+-FilePath \$ElevatedPowerShell/);
  assert.match(script, /Start-Process[^\n]+-Verb RunAs[^\n]+-Wait[^\n]+-WindowStyle Hidden/);
  assert.match(script, /-WorkingDirectory \$env:SystemRoot/);
  assert.doesNotMatch(script, /Start-Process[^\n]+\-FilePath "powershell\.exe"/);
  // The validated values travel inside the -EncodedCommand payload, not the
  // process environment: env vars do not survive ShellExecuteEx ->
  // CreateProcessAsUser, so the elevated side must not read them.
  assert.doesNotMatch(script, /CODEX_ROUTER_TRAY_REPAIR_TASK/);
  assert.match(script, /ConvertTo-RepairLiteral/);
  assert.match(script, /__TRAY_EXECUTE__/);
  assert.match(script, /-EncodedCommand/);
  assert.match(script, /if \(-not \(Test-TrayTaskFullControl/);
  assert.doesNotMatch(script, /icacls|takeown/i);
});

test("the POSIX tray launcher points Windows at that command", () => {
  const launcher = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  assert.match(launcher, /codex-router\.ps1 tray/);
  assert.doesNotMatch(launcher, /use scripts\/build-desktop-tray\.ps1 on Windows/);
});

test("setup reuses the tray command instead of repeating its steps", () => {
  const source = readFileSync(path.join(root, "src", "setup.mjs"), "utf8");
  assert.match(source, /"codex-router\.ps1"\),\s*\n\s*"tray",\s*\n\s*"install",/);
  // The build/stamp/register sequence must live in one place.
  assert.doesNotMatch(source, /build-desktop-tray\.ps1/);
});

test("Windows gets the same rebuild gating as the other tray platforms", async () => {
  // recordTrayBuild() threw on win32, so the one platform whose tray has to be
  // built deliberately was also the one that never recorded having been built
  // -- every update would have rebuilt it from scratch.
  const { trayRebuildPlan, traySourceFingerprint } = await import("../src/install-plan.mjs");
  assert.notEqual(trayRebuildPlan({ platform: "win32" }), "unsupported");
  // Same Tauri sources as Linux, so the fingerprints must agree.
  assert.equal(traySourceFingerprint(root, "win32"), traySourceFingerprint(root, "linux"));
  assert.notEqual(traySourceFingerprint(root, "win32"), "");
});
