import { join } from 'node:path'
import { vi } from 'vitest'
import type {
  Automation,
  AutomationRun,
  AutomationRunOptions,
  AutomationRunStatus
} from '../../shared/automations-types'
import type {
  AccountCapacityRow,
  CapacityProvider,
  ProviderAccountCapacitySnapshot
} from '../../shared/provider-account-capacity'
import type { Repo } from '../../shared/repo-types'
import type { SessionManageUnattended } from '../../shared/session-manage-types'
import type { RuntimeAutomationCreateInput } from '../runtime/omni-runtime'
import { CleanupRunController, type CleanupRunDeps } from './cleanup-runs'

export const MORNING = new Date('2026-09-25T09:00:00').getTime()
export const DAY_MS = 24 * 60 * 60 * 1000

export function capacityRow(
  provider: CapacityProvider,
  now: number,
  overrides: Partial<AccountCapacityRow> = {}
): AccountCapacityRow {
  return {
    provider,
    accountId: null,
    choiceId: 'system',
    email: null,
    detail: null,
    isDefault: true,
    isSystem: true,
    fiveHour: { remainingPercent: 80, resetsAt: null, windowMinutes: 300 },
    weekly: { remainingPercent: 70, resetsAt: null, windowMinutes: 10080 },
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: now - 60_000,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: null,
    ...overrides
  }
}

function makeRun(fields: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'automationId'>) {
  return {
    title: 'Session cleanup run',
    scheduledFor: 0,
    status: 'dispatching',
    trigger: 'manual',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0,
    ...fields
  } as AutomationRun
}

/** A cleanup controller over in-memory automations and runs, the way the service writes them. */
export function createCleanupHarness(dir: string, overrides: Partial<CleanupRunDeps> = {}) {
  const clock = { now: MORNING }
  const automations: Automation[] = []
  const runs: AutomationRun[] = []
  const registered = new Map<string, SessionManageUnattended>()
  const snapshot: { value: ProviderAccountCapacitySnapshot | null } = {
    value: {
      claude: [capacityRow('claude', clock.now)],
      codex: [capacityRow('codex', clock.now)],
      builtAt: clock.now
    }
  }
  const repo: Repo = {
    id: 'cleanup-repo',
    path: join(dir, 'workspace'),
    displayName: 'Session cleanup',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'folder'
  }
  const deps: CleanupRunDeps = {
    statePath: join(dir, 'session-steward', 'cleanup.json'),
    workspacePath: join(dir, 'workspace'),
    headless: false,
    now: () => clock.now,
    listAutomations: () => automations,
    listRuns: (automationId) =>
      runs
        .filter((run) => run.automationId === automationId)
        .toSorted((left, right) => right.createdAt - left.createdAt),
    defaultAgent: () => 'claude',
    settleNewWorkspace: vi.fn(async () => {}),
    addFolderRepo: vi.fn(async () => repo),
    createAutomation: vi.fn(async (input: RuntimeAutomationCreateInput) => {
      const automation = {
        ...input,
        id: `automation-${automations.length + 1}`,
        workspaceId: input.workspace?.replace(/^id:/, '') ?? null
      } as unknown as Automation
      automations.push(automation)
      return automation
    }),
    runNow: vi.fn(async (automationId: string, options: AutomationRunOptions) => {
      const run = makeRun({
        id: `run-${runs.length + 1}`,
        automationId,
        trigger: options.trigger ?? 'manual',
        promptOverride: options.promptOverride ?? null,
        createdAt: clock.now
      })
      runs.push(run)
      return run
    }),
    failRun: vi.fn(async (runId: string, error: string) =>
      harness.write(runId, 'dispatch_failed', { error })
    ),
    relay: vi.fn(async () => ({ scheduled: true })),
    readCapacity: () => snapshot.value,
    registerPane: vi.fn((paneKey: string, context: SessionManageUnattended) => {
      registered.set(paneKey, context)
      return () => registered.delete(paneKey)
    }),
    ...overrides
  }
  const harness = {
    clock,
    automations,
    runs,
    registered,
    snapshot,
    deps,
    controller: new CleanupRunController(deps),
    /** A fresh controller over the same file and runs: an app restart. */
    restart() {
      harness.controller.dispose()
      harness.controller = new CleanupRunController(deps)
      harness.controller.start()
      return harness.controller
    },
    /** The service writing a dispatch result, which it then tells its observers. */
    write(runId: string, status: AutomationRunStatus, fields: Partial<AutomationRun> = {}) {
      const index = runs.findIndex((run) => run.id === runId)
      runs[index] = { ...runs[index]!, ...fields, status }
      harness.controller.observe(runs[index]!)
      return runs[index]!
    },
    addRun(fields: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'automationId'>) {
      const run = makeRun(fields)
      runs.push(run)
      return run
    }
  }
  return harness
}

/** Lets every admission's background launch (ensure automation, run now) finish. */
export async function settleLaunch(controller: CleanupRunController): Promise<void> {
  await vi.waitFor(() => {
    if ((controller['launching'] as Set<string>).size > 0) {
      throw new Error('a cleanup launch is still in flight')
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
}
