import { join } from 'node:path'
import type { Store } from '../persistence'
import type { CodexAccountServiceLifecycle } from '../codex-accounts/codex-account-service-types'
import { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/runtime-selection'
import { CodexAccountService } from '../codex-accounts/service'
import { AccountCapacityService } from '../rate-limits/account-capacity-service'
import { getInitialClaudeRateLimitTarget } from '../rate-limits/claude-rate-limit-target'
import { getInitialCodexRateLimitTarget } from '../rate-limits/codex-rate-limit-target'
import { ProviderAccountDiscovery } from '../rate-limits/provider-account-discovery'
import { RateLimitService } from '../rate-limits/service'
import { ClaudeRuntimeAuthService } from './runtime-auth-service'
import { normalizeClaudeRuntimeSelection } from './runtime-selection'
import { ClaudeAccountService } from './service'

/** What `OrcaRuntimeService.setAccountServices` takes. */
export type RuntimeAccountServices = {
  claudeAccounts: ClaudeAccountService
  codexAccounts: CodexAccountService
  rateLimits: RateLimitService
  discovery: ProviderAccountDiscovery
}

export type RuntimeAccountServicesBundle = RuntimeAccountServices & {
  codexRuntimeHome: CodexRuntimeHomeService
  claudeRuntimeAuth: ClaudeRuntimeAuthService
  /** The four the runtime takes, as one object. */
  services: RuntimeAccountServices
  /** Starts account discovery: one scan now, then every minute. */
  start(): void
  stop(): void
}

/**
 * The account services a runtime needs to list accounts, read usage and route seats, built
 * in the order the desktop always built them. Left to the desktop: the Codex session-migration
 * scheduler and the trust-lane gate (passed in through `configureCodexRuntimeHome`), the
 * window the usage poller attaches to, and window-bound login interactions.
 */
export function createRuntimeAccountServices(input: {
  store: Store
  home: string
  userDataPath: string
  /** Runs after the Codex runtime home exists and before its account service does. */
  configureCodexRuntimeHome?: (
    runtimeHome: CodexRuntimeHomeService
  ) => CodexAccountServiceLifecycle | undefined
}): RuntimeAccountServicesBundle {
  const { store, userDataPath } = input
  const rateLimits = new RateLimitService()
  const codexRuntimeHome = new CodexRuntimeHomeService(store)
  const lifecycle = input.configureCodexRuntimeHome?.(codexRuntimeHome) ?? {}
  const codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome, lifecycle)
  const claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  const claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) => codexRuntimeHome.prepareForRateLimitFetch(target))
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth.prepareForRateLimitFetch(target)
  )
  rateLimits.accountCapacity = new AccountCapacityService(
    () => {
      const settings = store.getSettings()
      return {
        ...settings,
        activeClaudeManagedAccountId: normalizeClaudeRuntimeSelection(settings).host,
        activeCodexManagedAccountId: normalizeCodexRuntimeSelection(settings).host
      }
    },
    userDataPath,
    () => rateLimits.pushAccountCapacity()
  )
  const discovery = new ProviderAccountDiscovery({
    home: input.home,
    statePath: join(userDataPath, 'provider-account-discovery.json'),
    claude: claudeAccounts,
    codex: codexAccounts,
    onChanged: () => {
      void rateLimits.refreshDiscoveredAccountsUsage().catch(() => {})
    }
  })
  const services = { claudeAccounts, codexAccounts, rateLimits, discovery }
  return {
    ...services,
    codexRuntimeHome,
    claudeRuntimeAuth,
    services,
    start: () => discovery.start(),
    stop: () => discovery.stop()
  }
}
