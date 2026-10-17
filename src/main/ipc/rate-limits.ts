import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitRuntimeTarget } from '../../shared/rate-limit-types'
import type { CodexAccountService } from '../codex-accounts/service'

export function registerRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService
): void {
  ipcMain.handle('rateLimits:get', () => rateLimits.getState())
  ipcMain.handle('rateLimits:refresh', () => rateLimits.refresh())
  // Why: launch surfaces need real readings, not the cache; the stale-aware lane keeps each
  // provider's Retry-After and failure backoff, which the forced `refresh` bypasses.
  ipcMain.handle('rateLimits:refreshIfStale', () => rateLimits.refreshIfStale())
  ipcMain.handle('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  // Why: managed desktop resets must share the mobile mutation queue and durable ledger.
  ipcMain.handle('rateLimits:consumeCodexResetCredit', () =>
    codexAccounts.consumeCurrentRateLimitResetCredit()
  )
  ipcMain.handle('rateLimits:refreshClaudeForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshClaudeForTarget(target)
  )
  ipcMain.handle('rateLimits:setPollingInterval', (_event, ms: number) =>
    rateLimits.setPollingInterval(ms)
  )
  ipcMain.handle('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:refreshMiniMax', () => rateLimits.refresh())
  ipcMain.handle('rateLimits:refreshGrok', () => rateLimits.refreshGrok())
}
