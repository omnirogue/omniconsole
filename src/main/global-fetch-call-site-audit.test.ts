import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Global fetch (bare or via globalThis/global — unlike Electron's net.fetch)
// goes through Node's bundled undici, which can crash the whole process when
// an unread response body pauses the HTTP/1 parser and the peer closes the
// socket (nodejs/undici#5360, omni#8695). This applies to every Node process
// we ship: Electron main, the CLI, and the SSH relay.
//
// Each entry below maps an audited file to its expected number of matching
// lines. Real call sites must consume or cancel the body on every path,
// including !response.ok (see main/lib/unread-response-body.ts). A count
// change means a call site was added, removed, or moved: re-audit the file
// and update the count.
const AUDITED_GLOBAL_FETCH_LINES = new Map<string, number>([
  // HTTP call sites — body consumed or cancelled on every path, including !ok
  // Wallet reads cancel the response in finally, including authentication failures.
  ['main/ipc/omnirogue-credits-ipc.ts', 1],
  // Team MCP client cancels the response body on DELETE/notification/!ok and cancels the reader in finally.
  ['main/omnisi-team/mcp-client.ts', 2],
  ['main/runtime/workflow-script/discover-credit-quote.ts', 1],
  ['main/artifacts/artifact-cloud-request.ts', 1],
  // Context snapshots consume their bounded reader or cancel on !ok/unsupported content types.
  ['main/artifacts/artifact-context-reader.ts', 1],
  // Slite document reads consume JSON or cancel in finally, including rejected HTTP statuses.
  ['main/artifacts/slite-doc-reader.ts', 1],
  // Each parallel search/account request owns its body cleanup, even if its sibling rejects.
  ['main/artifacts/slite-document-search.ts', 1],
  // Local Ollama: /api/tags parses or cancels; /api/pull streams and cancels the reader in finally.
  ['main/local-ollama/ollama-inventory.ts', 2],
  // Model metadata parses JSON or cancels in finally, including rejected HTTP statuses.
  ['main/local-ollama/ollama-model-context.ts', 1],
  // omnios backoffice call sites — every path reads or cancels the body
  ['main/backoffice/backoffice-config.ts', 1],
  // Session-sync prefs: the read parses (bounded) or cancels; the write cancels on every status.
  ['main/backoffice/backoffice-account-sync.ts', 2],
  ['main/backoffice/backoffice-execution-observation.ts', 1],
  ['main/backoffice/backoffice-review-note.ts', 1],
  // Atomic create transfers body ownership to createBackofficeTask, which reads/cancels it.
  // The legacy tags-refusal body is read/cancelled before the helper issues its one retry.
  ['main/backoffice/backoffice-task-create-request.ts', 1],
  // The revision-fenced compatibility PATCH reads (json) or cancels on every path, including !ok.
  ['main/backoffice/backoffice-task-create.ts', 1],
  // Shared conditional reads own body cleanup before any coalesced caller receives a result.
  ['main/backoffice/backoffice-read-cache.ts', 1],
  ['main/backoffice/backoffice-work.ts', 2],
  // Exact downloads consume the bounded body or cancel it in finally, including !ok.
  ['main/backoffice/console-file-download.ts', 1],
  ['main/backoffice/console-job-results-client.ts', 1],
  // Lane 3 console workflow transport — readFetchResponseJsonWithinLimit reads or
  // cancels the body on every path, including !response.ok. Two call sites: the
  // JSON request and the multipart board-files upload that carries produced
  // artifacts to a card; both read the body through the same helper.
  // The bank export is CSV text, so it cannot go through the JSON transport; the
  // one call site reads the bounded body or cancels it on every other path.
  ['main/backoffice/console-companies-client.ts', 1],
  ['main/backoffice/console-workflow-transport.ts', 2],
  ['main/azure-devops/azure-devops-api-request.ts', 1],
  ['main/bitbucket/client.ts', 1],
  ['main/bitbucket/user-request.ts', 1],
  ['main/gitea/client.ts', 1],
  ['main/omni-profiles/profile-cloud-client.ts', 1],
  // WP-5a attach: posts the note/evidence to the hub task; the single call site
  // reads the bounded JSON body or cancels it via readFetchResponseJsonWithinLimit
  // on every path, including !response.ok.
  ['main/runtime/session-outcome-task-post.ts', 1],
  ['main/omni-profiles/profile-cloud-org-members-client.ts', 1],
  // Host model discovery consumes JSON or cancels the response in finally, including !ok.
  ['main/omp/omp-route-model-discovery.ts', 1],
  // The OpenRouter model catalog reads the JSON body, or cancels it when !ok.
  ['main/runtime/workflow-script/workflow-openrouter-catalog.ts', 1],
  // Supplies plain fetch as the request function; fetchCodexRateLimitsViaBackend
  // (codex-backend-usage-client.ts, audited above) owns reading/cancelling the
  // response body on every path, including !ok.
  ['main/rate-limits/codex-capacity-reading.ts', 1],
  ['main/rate-limits/codex-fetcher.ts', 3],
  ['main/runtime/peer-inbox-pending-client.ts', 1],
  ['main/runtime/relay/relay-http-client.ts', 2],
  ['main/runtime/relay/relay-region-preference.ts', 3],
  ['main/source-control/hosted-review-api-request.ts', 1],
  ['main/speech/openai-transcription-client.ts', 1],
  // Main HTTP port: one type declaration plus the Node fallback call. The fallback
  // returns the Response to its caller without inspecting it, so the consume/cancel
  // obligation stays with the caller — unchanged from when those callers used
  // Electron's net directly.
  ['main/network/http-client.ts', 2],
  // fetch appears only inside injected browser script source strings, not as a
  // call this process makes
  ['main/amp/agent-status-plugin-source.ts', 1],
  ['main/browser/browser-route-h3-egress-electron-main.ts', 1],
  ['main/browser/browser-route-persisted-worker-fixture.ts', 3],
  ['main/browser/browser-route-tcp-egress-fixture.ts', 1],
  ['main/opencode/status-plugin-post-source.ts', 1],
  ['main/pi/agent-status-extension-source.ts', 1],
  // local identifiers named `fetch` (git fetch), not HTTP
  ['main/ipc/worktree-remote.ts', 2],
  ['relay/git-handler-fetch-operations.ts', 1],
  // fetch mentioned only in a comment
  ['main/ipc/feedback.ts', 1]
])

// A line is a hit when it calls bare `fetch(` or touches `globalThis.fetch` /
// `global.fetch` in any way (call, alias, fallback like `input.fetch ??
// globalThis.fetch`). `typeof globalThis.fetch` type annotations are exempt.
const GLOBAL_FETCH_LINE = /(^|[^.\w])fetch\(|(?<!typeof )\bglobal(This)?\.fetch\b/

const SCANNED_ROOTS = ['main', 'cli', 'relay']

function globalFetchLineCounts(srcRoot: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const root of SCANNED_ROOTS) {
    for (const entry of readdirSync(join(srcRoot, root), {
      recursive: true,
      withFileTypes: true
    })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        continue
      }
      if (
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test-fixtures.ts') ||
        entry.name.endsWith('.d.ts')
      ) {
        continue
      }
      const filePath = join(entry.parentPath, entry.name)
      const content = readFileSync(filePath, 'utf8')
      if (!GLOBAL_FETCH_LINE.test(content)) {
        continue
      }
      const hits = content.split('\n').filter((line) => GLOBAL_FETCH_LINE.test(line)).length
      if (hits > 0) {
        counts.set(relative(srcRoot, filePath).split(sep).join('/'), hits)
      }
    }
  }
  return counts
}

describe('global fetch call-site audit (main, cli, relay)', () => {
  it('keeps every global-fetch line audited with its expected count', () => {
    const found = globalFetchLineCounts(join(__dirname, '..'))

    const drifted = [...found]
      .filter(([file, count]) => AUDITED_GLOBAL_FETCH_LINES.get(file) !== count)
      .map(([file, count]) => `${file}: found ${count} line(s)`)
      .sort()
    expect(
      drifted,
      'Global fetch (bare, globalThis.fetch, or global.fetch) uses undici, ' +
        'where an unread response body can crash the whole process (omni#8695). ' +
        'New or moved call sites must either use Electron net.fetch or consume/' +
        'cancel the response body on ALL paths (cancelUnreadResponseBody in ' +
        'main/lib/unread-response-body.ts), then update AUDITED_GLOBAL_FETCH_LINES.'
    ).toEqual([])

    const stale = [...AUDITED_GLOBAL_FETCH_LINES.keys()].filter((file) => !found.has(file)).sort()
    expect(stale, 'Remove audited entries whose global-fetch lines are gone.').toEqual([])
  })
})
