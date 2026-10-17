import { grokStreamProblem, preflightGrok } from './local-workflow-grok-preflight'
export { grokSandboxProblem } from './local-workflow-grok-preflight'
import { resolveOpenRouterCredential } from '../../structured-decisions/decision-credential'
import { workflowOpenRouterCatalog, workflowOpenRouterModels } from './workflow-openrouter-catalog'
import { workflowOllamaCatalog } from './workflow-ollama-catalog'
import { preflightWorkflowOllamaSeat } from './workflow-ollama-launch'
import { access } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { listAgentAccountChoices } from '../../../shared/agent-account-profiles'
import { workflowSeatCapacity } from '../../../shared/local-workflow-seat-capacity'
import { workflowCapacityRows } from './local-workflow-capacity-readings'
import type {
  LocalWorkflowRoute,
  LocalWorkflowSeatCatalog,
  ResolvedLocalWorkflowSeat
} from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import {
  WORKFLOW_CODEX_POLICY_REVISION,
  WORKFLOW_CODEX_WORKSPACE_POLICY_REVISION
} from '../../../shared/workflow-codex-command'
import { WORKFLOW_CLAUDE_WORKSPACE_POLICY_REVISION } from '../../../shared/workflow-claude-command'
import {
  workflowGrokEnvironment,
  WORKFLOW_GROK_POLICY_REVISION,
  WORKFLOW_GROK_PRIOR_POLICY_REVISIONS,
  WORKFLOW_GROK_WORKSPACE_POLICY_REVISION
} from '../../../shared/workflow-grok-command'
import { WORKFLOW_GEMINI_POLICY_REVISION } from '../../../shared/workflow-gemini-command'
import { workflowGeminiKeyLookup } from './workflow-gemini-key'
import type { OrcaRuntimeService } from '../omni-runtime'
import { workflowEvidenceDigest } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  WORKFLOW_ROUTES,
  workflowCatalogModels,
  workflowModelAvailable
} from './local-workflow-models'
import { assertWorkflowWorkspaceRoot } from './local-workflow-workspace-root'
import { assertWorkflowReadableRoot } from './local-workflow-read-scope'
import {
  assertBinaryVersion,
  grokHome,
  WorkflowCliVersionError
} from './local-workflow-cli-programs'

type Route = LocalWorkflowRoute

/**
 * Policies that pre-date streamed and workspace-read launches; old snapshots still carry them. The
 * first is the one the current route names. Later entries are earlier releases of the same frozen
 * argv: the working-agent release pinned Grok 1.0.40, and runs it admitted keep that revision.
 */
const legacyPoliciesByRoute: Partial<Record<Route, readonly string[]>> = {
  claude: ['claude-2.1.278-frozen-v2'],
  codex: [WORKFLOW_CODEX_POLICY_REVISION],
  grok: [WORKFLOW_GROK_POLICY_REVISION, ...WORKFLOW_GROK_PRIOR_POLICY_REVISIONS]
}
// The current code still runs the legacy frozen argv byte-for-byte, so it names both policies.
const policyByRoute: Record<Route, string> = {
  openrouter: 'openrouter-readonly-v1',
  ollama: 'ollama-local-readonly-v1',
  claude: `${legacyPoliciesByRoute.claude![0]};${WORKFLOW_CLAUDE_WORKSPACE_POLICY_REVISION}`,
  codex: `${WORKFLOW_CODEX_POLICY_REVISION};${WORKFLOW_CODEX_WORKSPACE_POLICY_REVISION}`,
  grok: `${WORKFLOW_GROK_POLICY_REVISION};${WORKFLOW_GROK_WORKSPACE_POLICY_REVISION}`,
  gemini: WORKFLOW_GEMINI_POLICY_REVISION
}

function selectedHome(route: Route, env: Record<string, string>): string {
  if (route === 'openrouter') {
    return join(homedir(), '.config', 'omni')
  }
  if (route === 'ollama') {
    return join(homedir(), '.ollama')
  }
  return route === 'claude'
    ? env.CLAUDE_CONFIG_DIR
    : route === 'codex'
      ? env.CODEX_HOME
      : route === 'grok'
        ? grokHome()
        : join(homedir(), '.gemini')
}

function revision(policy: string, home: string): string {
  let identity: unknown = { path: home, unavailable: true }
  if (isAbsolute(home)) {
    try {
      const canonical = realpathSync(home)
      const stat = statSync(canonical)
      if (stat.isDirectory()) {
        identity = { path: home, canonical, device: stat.dev, inode: stat.ino }
      }
    } catch {
      // A newly available or retargeted home must change the revision before Start.
    }
  }
  return `${policy}:${workflowEvidenceDigest(JSON.stringify(identity))}`
}

export function routeRevision(route: Route, home: string): string {
  return revision(policyByRoute[route], home)
}

/** Revisions seats carried before streamed launches; only runs without `access` may use them. */
export function legacyRouteRevisions(route: Route, home: string): string[] {
  return (legacyPoliciesByRoute[route] ?? []).map((policy) => revision(policy, home))
}

/** The legacy revision the current route names, if the route predates streamed launches. */
export function legacyRouteRevision(route: Route, home: string): string | undefined {
  return legacyRouteRevisions(route, home)[0]
}

export function accountChoices(
  runtime: Pick<OrcaRuntimeService, 'getAgentAccountSettings'>,
  route: Route
): { id: string; label: string; env: Record<string, string> }[] {
  if (route === 'ollama') {
    return [{ id: 'system:ollama', label: 'Ollama on this computer', env: {} }]
  }
  if (route === 'grok' || route === 'gemini' || route === 'openrouter') {
    const label = localWorkflowProviderLabel(route)
    return [{ id: `system:${route}`, label: `System ${label}`, env: {} }]
  }
  const system: { id: string; label: string; env: Record<string, string> } =
    route === 'claude'
      ? {
          id: 'system:claude',
          label: 'System Claude',
          env: { CLAUDE_CONFIG_DIR: join(homedir(), '.claude') }
        }
      : {
          id: 'system:codex',
          label: 'System Codex',
          env: { CODEX_HOME: join(homedir(), '.codex') }
        }
  return [system, ...listAgentAccountChoices(runtime.getAgentAccountSettings(), route)]
}

const geminiKey = () => workflowGeminiKeyLookup(selectedHome('gemini', {}))

function cliProblem(route: Route, cause: unknown): string {
  return cause instanceof WorkflowCliVersionError
    ? cause.message
    : `${localWorkflowProviderLabel(route)} CLI is not installed.`
}

/** What every launch of the route needs; working agents and follow-ups need nothing more. */
async function routeProblem(route: Route, home: string): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return 'This workflow process adapter is unavailable on Windows.'
  }
  if (route === 'openrouter') {
    return (await resolveOpenRouterCredential())
      ? undefined
      : 'Add OPENROUTER_API_KEY to ~/.config/omni/connections.env'
  }
  if (route === 'ollama') {
    // Whether the server answers, and with what, is read with its models (catalog below).
    return undefined
  }
  if (!isAbsolute(home)) {
    return 'The account directory must be an absolute path.'
  }
  if (route === 'claude' || route === 'codex') {
    try {
      await access(home)
    } catch {
      return 'The selected account directory is unavailable.'
    }
  }
  const gemini = route === 'gemini' ? geminiKey() : undefined
  if (gemini && 'missing' in gemini) {
    return gemini.missing
  }
  try {
    // Grok here is the `grok` on PATH, which working agents, follow-ups and frozen calls start.
    await assertBinaryVersion(route)
  } catch (cause) {
    return cliProblem(route, cause)
  }
  return undefined
}

export async function catalog(runtime: OrcaRuntimeService): Promise<LocalWorkflowSeatCatalog[]> {
  const rows = workflowCapacityRows(runtime)
  const now = Date.now()
  return await Promise.all(
    WORKFLOW_ROUTES.flatMap((route) =>
      accountChoices(runtime, route).map(async (choice) => {
        const home = selectedHome(route, choice.env)
        let unavailableReason = await routeProblem(route, home)
        let models = workflowCatalogModels(route)
        if (route === 'openrouter') {
          try {
            models = await workflowOpenRouterCatalog()
          } catch {
            unavailableReason ??= 'OpenRouter model catalog is unavailable.'
          }
        }
        if (route === 'ollama' && !unavailableReason) {
          const local = await workflowOllamaCatalog()
          models = local.models
          unavailableReason = local.unavailableReason
        }
        const streamUnavailableReason =
          route === 'grok' && !unavailableReason ? await grokStreamProblem() : undefined
        const prior = legacyRouteRevisions(route, home)
        return {
          agent: route,
          accountId: choice.id,
          accountLabel: choice.label,
          accountHome: home,
          ...(unavailableReason ? { unavailableReason } : {}),
          ...(streamUnavailableReason ? { streamUnavailableReason } : {}),
          ...(route === 'claude' || route === 'codex'
            ? { capacity: workflowSeatCapacity(rows, route, choice.id, now) }
            : {}),
          policyRevision: routeRevision(route, home),
          ...(prior.length ? { priorPolicyRevisions: prior } : {}),
          models
        } satisfies LocalWorkflowSeatCatalog
      })
    )
  )
}

/**
 * Credential-free environment for one frozen seat. `access` is the snapshot's: runs admitted
 * before streamed launches (no access) may resume under their legacy policy revision.
 */
export function accountEnvironment(
  runtime: OrcaRuntimeService,
  seat: ResolvedLocalWorkflowSeat,
  access?: LocalWorkflowHostSnapshot['access']
): NodeJS.ProcessEnv {
  const choice = accountChoices(runtime, seat.agent).find((entry) => entry.id === seat.accountId)
  const home = choice ? selectedHome(seat.agent, choice.env) : ''
  const legacy = access === undefined ? legacyRouteRevisions(seat.agent, home) : []
  const policies = [routeRevision(seat.agent, home), ...legacy]
  if (
    !choice ||
    !isAbsolute(home) ||
    !policies.includes(seat.policyRevision) ||
    !workflowModelAvailable(seat.agent, seat.model)
  ) {
    throw new Error(
      `${localWorkflowProviderLabel(seat.agent)}: the account or model changed. Refresh the workflow setup and start again.`
    )
  }
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SSL_CERT_FILE'
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key]
    }
  }
  Object.assign(env, choice.env)
  env.ORCA_PANE_KEY = ''
  delete env.ORCA_CODEX_HOME
  if (seat.agent === 'grok') {
    if (process.env.GROK_HOME) {
      env.GROK_HOME = process.env.GROK_HOME
    }
    Object.assign(env, workflowGrokEnvironment())
  }
  if (seat.agent === 'gemini') {
    // The one credential a route receives explicitly: Gemini has no account home to point at.
    const lookup = geminiKey()
    if ('missing' in lookup) {
      throw new Error(lookup.missing)
    }
    env.GEMINI_API_KEY = lookup.key
  }
  return env
}

export async function preflight(
  runtime: OrcaRuntimeService,
  snapshot: LocalWorkflowHostSnapshot
): Promise<void> {
  if (snapshot.access === 'workspace-read') {
    await assertWorkflowReadableRoot(await assertWorkflowWorkspaceRoot(snapshot))
  }
  for (const seat of snapshot.seats) {
    const env = accountEnvironment(runtime, seat, snapshot.access)
    if (seat.agent === 'grok') {
      await preflightGrok(snapshot, env)
      continue
    }
    if (seat.agent === 'openrouter') {
      const model = (await workflowOpenRouterModels()).find((entry) => entry.id === seat.model)
      if (!model?.structuredOutputs || (snapshot.access === 'workspace-read' && !model.tools)) {
        throw new Error('OpenRouter model does not support this workflow access mode.')
      }
      if (!(await resolveOpenRouterCredential())) {
        throw new Error('Add OPENROUTER_API_KEY to ~/.config/omni/connections.env')
      }
      continue
    }
    if (seat.agent === 'ollama') {
      await preflightWorkflowOllamaSeat(seat.model, snapshot.access === 'workspace-read')
      continue
    }
    await assertBinaryVersion(seat.agent, undefined, undefined, seat.model)
    if (seat.agent === 'claude') {
      await access(env.CLAUDE_CONFIG_DIR!)
    } else if (seat.agent === 'codex') {
      await access(join(env.CODEX_HOME!, 'auth.json'))
    }
  }
}
