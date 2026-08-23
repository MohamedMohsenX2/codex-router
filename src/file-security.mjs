import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Windows private-file hardening is one PowerShell spawn per call.
//
// Keeping it a single process is the point: `main` memoized the current SID
// and then ran `icacls` per file, and icacls is what this module exists to
// replace. `icacls /inheritance:r` left every explicit foreign ACE in place,
// `/grant:r:` could throw "system error 1332" over a non-canonical DACL, and
// its NTAccount translation throws IdentityNotMappedException for an orphaned
// SID or an unreachable DC. So the per-write cost is one cold-start of
// powershell.exe where main paid one icacls.exe — noticeably slower per write,
// but it is the price of a hardening path that cannot silently skip repairing
// the exact drift it is meant to repair.
//
// Internal callers that harden several paths at once go through
// protectPrivateFilesWin32 so that cost is paid once for the batch.
function powershellPrivateScript() {
  return [
    // A hardening failure must surface as a non-zero exit that Node can turn
    // into a thrown error. Without this PowerShell only rolls an unhandled
    // method-invocation exception into a statement that its caller may exit 0
    // on, which would let a credential write report success while the DACL
    // was never applied.
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $paths = @(ConvertFrom-Json -InputObject $env:CODEX_ROUTER_PRIVATE_FILES)",
    // Build each ACL from a fresh, empty FileSecurity rather than asking
    // GetAccessControl about the file's existing (possibly non-canonical)
    // DACL. SetAccessRuleProtection on a bare object never canonicalizes a
    // broken inherited/permission mix, so a file whose DACL is already
    // corrupt — the exact drift an install or doctor --fix must be able to
    // repair — cannot make this throw. The pre-existing DACL is replaced
    // outright instead of being edited toward compliance.
    // Only the DACL is persisted, not owner or group: persisting those
    // sections demands WRITE_OWNER, which Windows grants to nobody but the
    // owner raised it to even for the current identity. `icacls /inheritance:r`
    // needed only WRITE_DAC, so in exactly the non-canonical-DACL scenario
    // this repair exists for, a SetOwner/SetGroup would throw
    // UnauthorizedAccessException where the DACL fix would have succeeded.
    "  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "  $none = [System.Security.AccessControl.InheritanceFlags]::None",
    "  $propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
    "  $allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "  foreach ($p in $paths) {",
    "    $acl = [System.Security.AccessControl.FileSecurity]::new()",
    "    [void]$acl.SetAccessRuleProtection($true, $false)",
    "    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $none, $propagationNone, $allow)",
    "    [void]$acl.AddAccessRule($rule)",
    "    [System.IO.File]::SetAccessControl($p, $acl)",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

// Protect one or more paths in a single PowerShell process. Each file ends up
// with exactly one current-identity FullControl Allow rule and no inheritance —
// the same strictness privateFileIsProtected verifies. Owner/group are left
// untouched: persisting them costs WRITE_OWNER, which can fail where the DACL
// fix would succeed, so they are not part of the hardening assertion.
function protectPrivateFilesWin32(paths) {
  const list = [...paths];
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellPrivateScript()],
      {
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILES: JSON.stringify(list) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (error) {
    // The hardening script writes its diagnosis to stderr before exiting 1. A
    // non-zero exit is swallowed by execFileSync's throw, so fold the message
    // in here instead of discarding it: a `doctor` report needs it.
    const detail = String(error?.stderr?.trim?.() || error?.message || "").trim();
    throw new Error(detail ? `Failed to protect private file ACL: ${detail}` : `Failed to protect private file ACL.`);
  }
  return list;
}

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform === "win32") protectPrivateFilesWin32([target]);
  return target;
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    if (process.platform === "win32") {
      // One spawn hardens the temporary; the renameSync below then moves this
      // exact file over the target, and MoveFile carries the source's DACL
      // with it, so the destination inherits the same owner-only ACL without a
      // second PowerShell cold start. A pre-existing target that is being
      // replaced is discarded with the move, so it cannot leak permissions.
      protectPrivateFilesWin32([temporary]);
      renameSync(temporary, target);
    } else {
      protectPrivateFile(temporary);
      renameSync(temporary, target);
      protectPrivateFile(target);
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function writePrivateJson(target, value, { space = 2, directoryMode } = {}) {
  writePrivateFile(target, `${JSON.stringify(value, null, space)}\n`, { directoryMode });
  return value;
}

export function privateFileIsProtected(target) {
  if (!existsSync(target)) return false;
  if (process.platform !== "win32") return (statSync(target).mode & 0o777) === 0o600;
  const script = [
    // Get-Acl lazy-loads Microsoft.PowerShell.Security, which can fail under
    // concurrent Windows processes. The .NET API returns the same FileSecurity
    // object without importing a PowerShell module.
    "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$hasFullControl = $false",
    "$hasForeignAllow = $false",
    "$hasInheritedRule = $false",
    "foreach ($rule in $rules) { if ($rule.IsInherited) { $hasInheritedRule = $true }; if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { if ($rule.IdentityReference.Value -eq $sid) { if (($rule.FileSystemRights -band $fullControl) -eq $fullControl) { $hasFullControl = $true } } else { $hasForeignAllow = $true } } }",
    "[Console]::Out.Write(($acl.AreAccessRulesProtected -and -not $hasInheritedRule -and $hasFullControl -and -not $hasForeignAllow).ToString())",
  ].join("; ");
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}