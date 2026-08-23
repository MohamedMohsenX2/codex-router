// Shared OAuth and wire constants for Google's Antigravity coding client.

export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

// The installed-app client id above is a public identifier. The client secret
// is a working credential, so it is never bundled with the source. It must be
// supplied by every integration build that will mint tokens. It is read from
// the environment at call time rather than captured at import so a process can
// start without a secret and be pointed at a real one later.
export function requireAntigravityClientSecret() {
  const value = process.env.ANTIGRAVITY_CLIENT_SECRET;
  if (!value) {
    // Name the variable. Without it this arrives as "Sign-in failed" after the
    // operator has already granted Google five scopes, or as a refresh failure
    // inside the background service an hour later, and neither says what is
    // missing or where to put it.
    throw new Error(
      "Antigravity OAuth is not configured on this build: ANTIGRAVITY_CLIENT_SECRET is not set. " +
        "Set it in the environment before signing in, and re-run the installer so the background " +
        "service is given the same value -- launchd, systemd, and Task Scheduler do not inherit a shell.",
    );
  }
  return value;
}

// launchd, systemd, and Task Scheduler do not read a login shell, so every
// service definition builds an explicit environment allowlist. The secret has
// to be in it: without it a sign-in from a terminal succeeds and writes a
// token, and then the forwarder running under the service throws on its first
// refresh -- roughly an hour later, as a 502 with no obvious cause. The
// definitions are owner-only files (mode 0600), the same protection the
// proxy URLs beside it already rely on.
//
// An installer run that has no secret contributes no entry rather than an
// empty one. Service definitions are rewritten wholesale on every install, so
// re-running the installer without the variable is also how it is removed.
export function antigravityClientSecretEnvironment(environment = process.env) {
  const value = environment.ANTIGRAVITY_CLIENT_SECRET;
  return value ? { ANTIGRAVITY_CLIENT_SECRET: value } : {};
}

export const ANTIGRAVITY_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]);

const DEFAULT_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export function validateAntigravityRedirectUri(
  value = process.env.ANTIGRAVITY_REDIRECT_URI || DEFAULT_REDIRECT_URI,
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ANTIGRAVITY_REDIRECT_URI must be a valid loopback URL.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    url.port === "0" ||
    !url.pathname.startsWith("/")
  ) {
    throw new Error(
      "ANTIGRAVITY_REDIRECT_URI must be an HTTP localhost/loopback URL with an explicit port, path, and no credentials, query, or fragment.",
    );
  }
  return url;
}

// Resolved on demand rather than at import. This module is in the static graph
// of doctor.mjs, setup.mjs and providers.mjs, so validating a top-level
// constant let one bad ANTIGRAVITY_REDIRECT_URI throw before any of those
// commands ran a single line -- a misconfigured environment variable for one
// provider taking down every unrelated command.
export function antigravityRedirectUri() {
  return validateAntigravityRedirectUri().toString();
}

export function antigravityCallbackTarget(value = antigravityRedirectUri()) {
  const url = validateAntigravityRedirectUri(value);
  return {
    host: url.hostname === "localhost"
      ? "127.0.0.1"
      : url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port),
    path: url.pathname,
    redirectUri: url.toString(),
  };
}

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINT = (
  process.env.ANTIGRAVITY_ENDPOINT ||
  "https://daily-cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

export const ANTIGRAVITY_PROD_ENDPOINT = (
  process.env.ANTIGRAVITY_PROD_ENDPOINT || "https://cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

export const ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_IDE_VERSION || "1.1.13";
export const ANTIGRAVITY_BUILD = process.env.ANTIGRAVITY_BUILD || "964361259";
export const ANTIGRAVITY_SURFACE = process.env.ANTIGRAVITY_SURFACE || "cli";

function normalizePlatform(platform) {
  if (platform === "win32") return "windows";
  return platform || "unknown";
}

function normalizeArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch || "unknown";
}

export function antigravityUserAgent(
  platform = process.platform,
  arch = process.arch,
) {
  if (process.env.ANTIGRAVITY_USER_AGENT) return process.env.ANTIGRAVITY_USER_AGENT;
  return `antigravity/${ANTIGRAVITY_SURFACE}/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}; cl=${ANTIGRAVITY_BUILD}; auth_method=consumer)`;
}

export function antigravityBootstrapHeaders(accessToken) {
  return {
    "User-Agent": antigravityUserAgent(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

export function antigravityLoadCodeAssistMetadata() {
  return { ideType: "ANTIGRAVITY" };
}

// Kept for compatibility with callers that have not yet moved to the minimal
// bootstrap body. Current clients send only ideType in request metadata.
export function antigravityClientMetadata() {
  return JSON.stringify(antigravityLoadCodeAssistMetadata());
}
