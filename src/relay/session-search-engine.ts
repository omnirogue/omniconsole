import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { createSessionSearchEngine } from '../main/session-search/session-search-engine'
import { SESSION_SEARCH_SERVICE_PROTOCOL } from '../main/session-search/session-search-service-protocol'
import type { SessionSearchServiceSearchValue } from '../main/session-search/session-search-service-protocol'
import type { SshSessionSearchParams, SshSessionSearchResult } from '../shared/ssh-session-search'

/** Lives only in the existing low-priority history child, never in the PTY relay event loop. */
export function createRelaySessionSearch(remoteHome: string, namespace = `relay-${process.ppid}`) {
  let engine: ReturnType<typeof createSessionSearchEngine> | null = null
  // Multiple relay owners can coexist; each socket keeps its own single-writer index.
  const indexKey = createHash('sha256').update(namespace).digest('hex').slice(0, 32)
  return {
    search(params: SshSessionSearchParams): SshSessionSearchResult {
      let sqlite: unknown
      try {
        sqlite = process.getBuiltinModule?.('node:sqlite')
      } catch {
        // Node 18 companions still serve history and terminals without content indexing.
      }
      if (!sqlite || typeof (sqlite as { DatabaseSync?: unknown }).DatabaseSync !== 'function') {
        return {
          supported: false,
          message: 'Content search requires node:sqlite on this SSH host.'
        }
      }
      engine ??= createSessionSearchEngine({
        type: 'init',
        protocol: SESSION_SEARCH_SERVICE_PROTOCOL,
        // Version GC already preserves live relay owners and removes their retired directory.
        dbPath: join(__dirname, 'session-search', `index-v1-${indexKey}.sqlite`),
        modelDir: join(__dirname, 'session-search-model'),
        homeDir: remoteHome,
        appDataDirs: [
          process.platform === 'darwin'
            ? join(remoteHome, 'Library', 'Application Support', 'omniconsole-ide')
            : process.platform === 'win32'
              ? join(remoteHome, 'AppData', 'Roaming', 'omniconsole-ide')
              : join(remoteHome, '.config', 'omniconsole-ide')
        ],
        hostLabel: hostname(),
        dutyCycle: 0.25,
        passIntervalMs: 90_000
      })
      const value = engine.execute({
        type: 'request',
        id: 0,
        op: 'search',
        ...params
      }) as SessionSearchServiceSearchValue
      return { supported: true, ...value }
    },
    shutdown(): void {
      engine?.shutdown()
      engine = null
    }
  }
}
