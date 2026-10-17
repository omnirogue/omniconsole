import { homedir } from 'node:os'
import { z } from 'zod'
import { discoverExistingAccountDirectories } from '../../../rate-limits/existing-account-directories'
import { defineMethod } from '../core'

export const IMPORT_EXISTING_ACCOUNTS_METHOD = defineMethod({
  name: 'accounts.importExisting',
  params: z.object({
    provider: z.enum(['claude', 'codex']),
    preview: z.boolean().optional(),
    paths: z.array(z.string().min(1)).max(100).optional()
  }),
  handler: async ({ provider, preview, paths }, { runtime, clientKind }) => {
    if (clientKind !== undefined) {
      throw new Error('Import existing accounts on the host where they are signed in.')
    }
    let imported = 0
    let alreadyAdded = 0
    let needsAttention = 0
    const directories = discoverExistingAccountDirectories(homedir()).filter(
      (entry) => entry.provider === provider
    )
    if (preview) {
      return { directories }
    }
    if (!paths?.length) {
      throw new Error('Choose the logins to import first.')
    }
    const selected = new Set(paths)
    if (paths.some((path) => !directories.some((entry) => entry.path === path))) {
      throw new Error('A selected profile is no longer available. Find your logins again.')
    }
    const previousCodexDefault =
      provider === 'codex'
        ? (runtime.getAccountsSnapshot().codex.activeAccountIdsByRuntime?.host ??
          runtime.getAccountsSnapshot().codex.activeAccountId ??
          null)
        : null
    for (const entry of directories.filter((entry) => selected.has(entry.path))) {
      try {
        await (provider === 'claude'
          ? runtime.addClaudeAccountFromConfigDir(entry.path, { runtime: 'host' })
          : runtime.addCodexAccountFromHome(entry.path, { runtime: 'host' }))
        imported += 1
      } catch (error) {
        if (error instanceof Error && /already added/i.test(error.message)) {
          alreadyAdded += 1
        } else {
          needsAttention += 1
        }
      }
    }
    if (
      provider === 'codex' &&
      (runtime.getAccountsSnapshot().codex.activeAccountIdsByRuntime?.host ??
        runtime.getAccountsSnapshot().codex.activeAccountId ??
        null) !== previousCodexDefault
    ) {
      await runtime.selectCodexAccountForTarget(previousCodexDefault, {
        runtime: 'host',
        wslDistro: null
      })
    }
    return { imported, alreadyAdded, needsAttention, snapshot: runtime.getAccountsSnapshot() }
  }
})
