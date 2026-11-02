// Whether this process is an e2e test run. It gates the test hooks (`globalThis.__ccTest`,
// arbitrary main-process access), recorded notifications and http loopback token URLs, so it is
// one function with a unit test (test/unit/test-run.test.ts) instead of an expression inlined in
// index.ts: a packaged build must never take a test-only path, whatever its environment says.
// (The fake secret store has the same rule in secret-store.ts selectSecretStore.)

export function isTestRun(env: Record<string, string | undefined>, isPackaged: boolean): boolean {
  return env.CC_COCKPIT_TEST === '1' && !isPackaged
}
