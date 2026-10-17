import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import {
  parseWorkflowCliVersion,
  workflowCliVersionAtLeast,
  WORKFLOW_CLI_MINIMUM_VERSIONS
} from '../../../shared/workflow-cli-version'
import { WORKFLOW_FLEET_UNSET_API_KEYS } from './workflow-fleet-remote-shell'
import { workflowModelMinimumCliVersion } from './local-workflow-models'

/** The CLIs a dispatched seat runs, each on the host's own subscription login. */
export const WORKFLOW_FLEET_SEAT_ROUTES = ['claude', 'codex'] as const
export type WorkflowFleetSeatRoute = (typeof WORKFLOW_FLEET_SEAT_ROUTES)[number]
/** Claude's subscription logins: claude.ai OAuth, or a long-lived subscription token. */
const CLAUDE_SUBSCRIPTION_METHODS = new Set(['claude.ai', 'oauth_token'])
// Codex/Claude's read-only sandboxes would still expose these outside the home (see
// local-workflow-read-scope.ts); resolved on the host, per its OS.
const OUTSIDE_DATA_ROOTS: Record<string, readonly string[]> = {
  Darwin: ['/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/tmp'],
  Linux: ['/home', '/root', '/tmp', '/var/tmp', '/mnt', '/media', '/run/user']
}

/** The host's facts a dispatched run needs, as the probe printed them. */
export type WorkflowFleetHostFacts = {
  home: string
  os: string
  existing: string[]
  versions: Partial<Record<WorkflowFleetSeatRoute, string>>
  claudeAuth?: { loggedIn: boolean; authMethod: string }
  codexLogin?: 'chatgpt' | 'api-key' | 'none'
}

/** One probe for every route the run seats: versions and logins, API key variables unset first. */
export function workflowFleetProbeScript(routes: readonly WorkflowFleetSeatRoute[]): string {
  const roots = [...new Set(Object.values(OUTSIDE_DATA_ROOTS).flat())]
  const lines = [
    WORKFLOW_FLEET_UNSET_API_KEYS,
    'home=$(cd "$HOME" && pwd -P) || exit 90',
    `printf 'home=%s\\n' "$home"`,
    `printf 'os=%s\\n' "$(uname -s)"`,
    `for p in ${roots.join(' ')}; do [ -e "$p" ] && printf 'exists=%s\\n' "$p"; done`
  ]
  if (routes.includes('claude')) {
    lines.push(
      `printf 'claude.version=%s\\n' "$(claude --version 2>/dev/null | head -n 1)"`,
      `printf 'claude.auth.begin\\n'`,
      'claude auth status 2>/dev/null',
      `printf '\\nclaude.auth.end\\n'`
    )
  }
  if (routes.includes('codex')) {
    lines.push(
      `printf 'codex.version=%s\\n' "$(codex --version 2>/dev/null | head -n 1)"`,
      // Only which kind of login is printed: an API-key login's line names part of the key.
      `case "$(codex login status 2>&1 | head -n 1)" in 'Logged in using ChatGPT'*) printf 'codex.login=chatgpt\\n' ;; *'API key'*) printf 'codex.login=api-key\\n' ;; *) printf 'codex.login=none\\n' ;; esac`
    )
  }
  return lines.join('\n')
}

export function parseWorkflowFleetProbe(stdout: string): WorkflowFleetHostFacts | undefined {
  const facts: WorkflowFleetHostFacts = { home: '', os: '', existing: [], versions: {} }
  const lines = stdout.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line === 'claude.auth.begin') {
      const end = lines.indexOf('claude.auth.end', index)
      const body = lines.slice(index + 1, end === -1 ? undefined : end).join('\n')
      try {
        const status = JSON.parse(body) as { loggedIn?: unknown; authMethod?: unknown }
        facts.claudeAuth = {
          loggedIn: status.loggedIn === true,
          authMethod: typeof status.authMethod === 'string' ? status.authMethod : 'none'
        }
      } catch {
        facts.claudeAuth = { loggedIn: false, authMethod: 'none' }
      }
      index = end === -1 ? lines.length : end
      continue
    }
    const match = /^([a-z.]+)=(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const [, key, value] = match
    if (key === 'home') {
      facts.home = value!
    } else if (key === 'os') {
      facts.os = value!
    } else if (key === 'exists') {
      facts.existing.push(value!)
    } else if (key === 'claude.version' || key === 'codex.version') {
      const route = key.split('.')[0] as WorkflowFleetSeatRoute
      const version = parseWorkflowCliVersion(value!)
      if (version) {
        facts.versions[route] = version
      }
    } else if (key === 'codex.login') {
      facts.codexLogin = value === 'chatgpt' || value === 'api-key' ? value : 'none'
    }
  }
  return facts.home.startsWith('/') ? facts : undefined
}

/** Why a route cannot run on the host, by name; undefined when it can. */
export function workflowFleetRouteProblem(
  host: string,
  route: WorkflowFleetSeatRoute,
  facts: WorkflowFleetHostFacts,
  /** The run's seat models on this route; some need a newer CLI than the route. */
  models: readonly string[] = []
): string | undefined {
  const label = localWorkflowProviderLabel(route)
  const minimum = WORKFLOW_CLI_MINIMUM_VERSIONS[route]
  const version = facts.versions[route]
  if (!version) {
    return `${label} CLI is not installed on ${host}.`
  }
  if (!workflowCliVersionAtLeast(version, minimum)) {
    return `${label} CLI on ${host} is ${version}; workflows need ${minimum} or newer.`
  }
  for (const model of models) {
    const modelMinimum = workflowModelMinimumCliVersion(route, model)
    if (!workflowCliVersionAtLeast(version, modelMinimum)) {
      return `${label} CLI on ${host} is ${version}; ${model} needs ${modelMinimum} or newer.`
    }
  }
  if (route === 'claude') {
    const auth = facts.claudeAuth
    if (!auth?.loggedIn) {
      return `Claude is not signed in on ${host} (claude auth status reports no login over SSH).`
    }
    if (!CLAUDE_SUBSCRIPTION_METHODS.has(auth.authMethod)) {
      return `Claude on ${host} signs in with ${auth.authMethod}, not a subscription; workflow seats never use API keys.`
    }
    return undefined
  }
  if (facts.codexLogin === 'api-key') {
    return `Codex on ${host} is signed in with an API key; workflow seats run only on a ChatGPT subscription login.`
  }
  return facts.codexLogin === 'chatgpt'
    ? undefined
    : `Codex is not signed in on ${host} (codex login status).`
}

/** The paths a dispatched Codex seat is denied on the host: its home, and data outside it. */
export function workflowFleetHiddenPaths(
  facts: Pick<WorkflowFleetHostFacts, 'home' | 'os' | 'existing'>
): string[] {
  const outside = (OUTSIDE_DATA_ROOTS[facts.os] ?? []).filter(
    (path) => path !== facts.home && facts.existing.includes(path)
  )
  return [facts.home, ...outside]
}
