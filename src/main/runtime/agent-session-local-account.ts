import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  agentLaunchRefusal,
  type AgentLaunchReadinessAccount
} from '../../shared/agent-launch-account'
import {
  chooseVerifiedLaunchAccount,
  classifyLaunchAccountRow,
  launchAccountCandidates,
  launchAccountReceipt,
  launchFableRule,
  launchRefusalText,
  LAUNCH_ACCOUNT_FRESH_MS,
  LAUNCH_ACCOUNT_REFRESH_AFTER_MS,
  LAUNCH_ACCOUNT_REFRESH_CONCURRENCY,
  LAUNCH_ACCOUNT_REFRESH_WAIT_MS,
  type LaunchFableRule
} from '../../shared/account-launch-verdict'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { AccountCapacityRow, CapacityProvider } from '../../shared/provider-account-capacity'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import { localHostLabel } from '../local-host-label'
import type { AccountCapacityService } from '../rate-limits/account-capacity-service'
import type { AgentLaunchWorkspace } from './agent-session-ssh-account'

export type LaunchAccountCapacity = Pick<AccountCapacityService, 'snapshot' | 'refresh' | 'resolve'>

export const NO_ACCOUNT_SERVICES_REFUSAL =
  'This OmniConsole runs without account services, so it cannot verify account capacity. Nothing launched.'
export const WSL_ACCOUNT_REFUSAL =
  'Verified account selection is not available for WSL workspaces. Nothing launched.'

type FreshenState = {
  /** When this module last forced each row, and the batch carrying that fetch. */
  forced: Map<string, { at: number; batch: Promise<unknown> }>
  /** When a refresh this module awaited last read each row's Fable window. */
  fableAt: Map<string, number>
}

// Why per service: a failed fetch leaves readingAt null, and force bypasses the service's own
// throttle, so without this every launch would re-hit a failing usage endpoint.
const freshenStates = new WeakMap<LaunchAccountCapacity, FreshenState>()

const rowKey = (provider: CapacityProvider, row: AccountCapacityRow) =>
  `${provider}:${row.choiceId}`

function freshenState(capacity: LaunchAccountCapacity): FreshenState {
  const state = freshenStates.get(capacity) ?? { forced: new Map(), fableAt: new Map() }
  freshenStates.set(capacity, state)
  return state
}

/** Only a usage fetch reads the Fable window; a live statusline post carries the old one over. */
function noteFableReading(
  state: FreshenState,
  key: string,
  reading: ProviderRateLimits,
  since: number
): void {
  if (
    reading.status === 'ok' &&
    reading.usageMetadata?.source !== 'live-session' &&
    reading.updatedAt >= since
  ) {
    state.fableAt.set(key, reading.updatedAt)
  }
}

/** Force-refresh stale eligible rows, at most 4 at a time and 15 s overall; late readings stay stale. */
async function freshenLaunchAccounts(
  capacity: LaunchAccountCapacity,
  provider: CapacityProvider,
  fable: LaunchFableRule
): Promise<FreshenState> {
  const state = freshenState(capacity)
  const work = (async () => {
    await capacity.resolve()
    const now = Date.now()
    const old = (at: number | null | undefined) =>
      at == null || now - at > LAUNCH_ACCOUNT_REFRESH_AFTER_MS
    const needsFable = (row: AccountCapacityRow) =>
      fable === 'require' || (fable === 'gate' && row.fableWeekly !== null)
    const rows = capacity.snapshot()[provider]
    const stale = rows.filter(
      (row) =>
        row.launchEnv &&
        row.state !== 'signed-out' &&
        row.state !== 'limited' &&
        row.readingPausedUntil === null &&
        (old(row.readingAt) || (needsFable(row) && old(state.fableAt.get(rowKey(provider, row)))))
    )
    const due = stale.filter((row) => {
      const last = state.forced.get(rowKey(provider, row))
      return !last || now - last.at >= LAUNCH_ACCOUNT_REFRESH_AFTER_MS
    })
    const batch = mapSettledWithConcurrency(due, LAUNCH_ACCOUNT_REFRESH_CONCURRENCY, async (row) =>
      noteFableReading(
        state,
        rowKey(provider, row),
        await capacity.refresh(provider, row.accountId, { force: true }),
        now
      )
    )
    for (const row of due) {
      state.forced.set(rowKey(provider, row), { at: now, batch })
    }
    // Why: a row another launch just forced joins that fetch instead of being judged without it.
    await Promise.all(new Set(stale.map((row) => state.forced.get(rowKey(provider, row))!.batch)))
  })()
  await withTimeout(work, LAUNCH_ACCOUNT_REFRESH_WAIT_MS, undefined)
  return state
}

export async function chooseLocalLaunchAccount(
  capacity: LaunchAccountCapacity,
  provider: CapacityProvider,
  model: string | undefined
) {
  const state = await freshenLaunchAccounts(capacity, provider, launchFableRule(provider, model))
  const now = Date.now()
  const fableReadingAt = (row: AccountCapacityRow) =>
    state.fableAt.get(rowKey(provider, row)) ?? null
  const rows = capacity.snapshot()[provider]
  return {
    choice: chooseVerifiedLaunchAccount(rows, { provider, model, now, fableReadingAt }),
    now,
    fableReadingAt
  }
}

/** Throws unless the workspace still runs here, outside WSL; returns its identity for the fence. */
function localWorkspaceSnapshot(
  workspace: AgentLaunchWorkspace | null,
  runsInWsl: (workspace: AgentLaunchWorkspace) => boolean
): string {
  if (!workspace) {
    throw agentLaunchRefusal(
      'agent_session_host_mismatch',
      'The launch workspace is no longer registered. Nothing launched.'
    )
  }
  const stamp = workspace.repo?.executionHostId ?? workspace.folderWorkspace?.executionHostId
  // Why runtime:*: a runtime stamps setups a paired client made there `runtime:<id>`; both mean here.
  const local = !stamp || stamp === 'local' || stamp.startsWith('runtime:')
  if (workspace.connectionId || !local) {
    const workspaceHostId = workspace.connectionId ? `ssh:${workspace.connectionId}` : stamp
    throw agentLaunchRefusal(
      'agent_session_host_mismatch',
      `The launch workspace runs on ${workspaceHostId}, not on this computer. Nothing launched.`,
      { expectedHostId: 'local', workspaceHostId }
    )
  }
  // Why the runtime's check too: a project or shell default can run a Windows path in WSL,
  // where spawn drops the host pin for the WSL-selected login.
  if (isWslUncPath(workspace.path) || runsInWsl(workspace)) {
    throw agentLaunchRefusal('agent_session_account_unverified', WSL_ACCOUNT_REFUSAL)
  }
  return JSON.stringify([
    workspace.id,
    workspace.path,
    workspace.repo?.id ?? workspace.folderWorkspace?.id ?? null,
    workspace.repo?.path ?? workspace.folderWorkspace?.folderPath ?? null,
    'local'
  ])
}

/** Best verified account among this runtime's own capacity rows, pinned and fenced until spawn. */
export async function prepareAgentSessionLocalAccount(args: {
  request: RuntimeCreateAgentSessionRequest
  workspace: AgentLaunchWorkspace
  currentWorkspace: () => AgentLaunchWorkspace | null
  /** Whether a local spawn of this workspace runs in WSL (see agent-launch-wsl-runtime.ts). */
  runsInWsl: (workspace: AgentLaunchWorkspace) => boolean
  capacity: LaunchAccountCapacity | null
  signal?: AbortSignal
}) {
  const { request, capacity } = args
  if (!request.sshAccountSelection) {
    return null
  }
  const refuse = (message: string) =>
    agentLaunchRefusal('agent_session_account_unverified', message)
  if (request.viewMode !== 'terminal') {
    throw refuse(
      'Best-verified account selection requires an interactive terminal session. Nothing launched.'
    )
  }
  if (request.launchPreferences?.codexAccountId) {
    throw refuse(
      'A pinned account cannot be combined with best-verified account selection. Nothing launched.'
    )
  }
  const provider = request.agent
  if (provider !== 'claude' && provider !== 'codex') {
    throw refuse(
      `Verified account selection covers claude and codex, not ${provider}. Nothing launched.`
    )
  }
  const expected = localWorkspaceSnapshot(args.workspace, args.runsInWsl)
  if (!capacity) {
    throw refuse(NO_ACCOUNT_SERVICES_REFUSAL)
  }
  const connected = () => {
    if (args.signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }
  connected()
  const { choice, now, fableReadingAt } = await chooseLocalLaunchAccount(
    capacity,
    provider,
    request.launchPreferences?.model
  )
  const pick = choice.pick
  if (!pick) {
    throw agentLaunchRefusal(
      'agent_session_account_unverified',
      launchRefusalText(provider, localHostLabel(), choice.verdicts),
      { accounts: launchAccountCandidates(choice.verdicts) }
    )
  }
  const homeKey = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  // Why: an empty home is not a pin, so spawn preflight would silently re-balance.
  if (!pick.row.launchEnv?.[homeKey]?.trim()) {
    throw refuse(
      `The chosen ${provider} account has no launch home on this computer. Nothing launched.`
    )
  }
  const pinned = JSON.stringify(pick.row.launchEnv)
  const stale = () =>
    refuse(
      `The chosen ${provider} account's capacity on ${localHostLabel()} is no longer verified (its usage or Fable reading aged past ${LAUNCH_ACCOUNT_FRESH_MS / 1000} s, it reached a limit, or the selected default changed). Nothing launched. Run the same command again.`
    )
  const assertCurrent = () => {
    connected()
    if (localWorkspaceSnapshot(args.currentWorkspace(), args.runsInWsl) !== expected) {
      throw agentLaunchRefusal(
        'agent_session_host_mismatch',
        'The launch workspace changed during account selection. Nothing launched.'
      )
    }
    const rows = capacity.snapshot()[provider]
    const current = rows.find((row) => row.choiceId === pick.row.choiceId)
    if (
      !current ||
      JSON.stringify(current.launchEnv) !== pinned ||
      classifyLaunchAccountRow(current, {
        now: Date.now(),
        freshMs: LAUNCH_ACCOUNT_FRESH_MS,
        fable: choice.fable,
        fableReadingAt: fableReadingAt(current)
      }).state !== 'fresh' ||
      (pick.row.isSystem && rows.some((row) => !row.isSystem && row.isDefault))
    ) {
      throw stale()
    }
  }
  assertCurrent()
  return {
    env: { ...pick.row.launchEnv },
    assertCurrent,
    receipt: launchAccountReceipt({ hostId: 'local', provider, choice: { ...choice, pick }, now }),
    fableVerified: pick.verdict.fableVerified
  }
}

/** What a launch would pick right now: the same freshen and chooser, with no pin and no fence. */
export async function previewLocalLaunchAccount(args: {
  agent: CapacityProvider
  model?: string
  path: string
  runsInWsl: boolean
  capacity: LaunchAccountCapacity | null
}): Promise<AgentLaunchReadinessAccount> {
  if (!args.capacity) {
    return { verified: false, refusal: NO_ACCOUNT_SERVICES_REFUSAL, accounts: [] }
  }
  if (args.runsInWsl || isWslUncPath(args.path)) {
    return { verified: false, refusal: WSL_ACCOUNT_REFUSAL, accounts: [] }
  }
  const { choice, now } = await chooseLocalLaunchAccount(args.capacity, args.agent, args.model)
  const pick = choice.pick
  return pick
    ? {
        verified: true,
        receipt: launchAccountReceipt({
          hostId: 'local',
          provider: args.agent,
          choice: { ...choice, pick },
          now
        })
      }
    : {
        verified: false,
        refusal: launchRefusalText(args.agent, localHostLabel(), choice.verdicts),
        accounts: launchAccountCandidates(choice.verdicts)
      }
}
