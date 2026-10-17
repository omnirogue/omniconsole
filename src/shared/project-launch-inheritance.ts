import {
  validateSessionContext,
  type SessionContextAttachment
} from './session-context-attachments'
import type { ProjectAgent, ProjectSettings } from './project-settings'
import { AGENT_TEMPLATE_DEFAULT_ID } from './agent-templates'
import {
  dedupeLaunchAttachments,
  launchManifestPrompt,
  type LaunchManifest,
  type LaunchManifestSource
} from './launch-manifest'
import { isPathInsideOrEqual, resolveRuntimePath } from './cross-platform-path'

/**
 * What a session started in a project inherits, resolved for the computer it runs on (plan §8
 * F3/F4). Order: the project's settings, then the target's own launch context, then the session's
 * own additions, then the project items the person unticked for this session. References are
 * stored host-independent where a form exists and resolved per host here; a host-bound one the
 * target lacks is listed as "not on <host>", never dropped silently.
 */

/** What the target computer has, as the caller could read it. */
export type ProjectLaunchHost = {
  hostId: string
  label: string
  /** That repo's checkout on this host, or null when it has none registered. */
  repoCheckout: (gitIdentity: string) => string | null
  /** That skill on this host; `unknown` when this host's skills cannot be read from here. */
  skill: (name: string) => { path: string } | null | 'unknown'
}

export type ProjectLaunchInput = {
  project: { folderId: string; name: string; settings: ProjectSettings }
  launch: readonly SessionContextAttachment[]
  session: readonly SessionContextAttachment[]
  /** Project item ids (attachment ids, `repo:<identity>`) left out of this session. */
  removed: readonly string[]
  /** A stand-in the person picked for a project item this host lacks, by that item's id. */
  replaced?: Readonly<Record<string, SessionContextAttachment>>
  host: ProjectLaunchHost
  /** The template the launcher chose; null or Default when it chose none. */
  templateId: string | null
}

export type InheritedState = 'inherited' | 'unverified' | 'not-on-host' | 'replaced' | 'removed'

/** One project item as the launcher shows it: greyed, with an "x", or flagged for this host. */
export type InheritedItem = {
  id: string
  kind: SessionContextAttachment['kind'] | 'repo'
  title: string
  state: InheritedState
  /** The host a host-bound item lives on, for "not on <host>". */
  hostId?: string
  /** The repo an item travels by (contract 8), for "from <repo>". */
  repo?: string
}

export type NotOnHostItem = Pick<InheritedItem, 'id' | 'kind' | 'title'> & {
  hostId: string | null
}

export type ProjectLaunchResolution = {
  projectLine: string
  /** What the session gets, in inheritance order. */
  attachments: SessionContextAttachment[]
  inherited: InheritedItem[]
  notOnHost: NotOnHostItem[]
  /** The project's agent this launch uses; null leaves the launcher's own template in charge. */
  agent: ProjectAgent | null
  /** Every project agent, named so the session may use them as subagents. */
  roster: { templateId: string; name: string }[]
  /** Why the inherited context cannot be delivered as is, or null. */
  error: string | null
}

export const projectRepoItemId = (gitIdentity: string) => `repo:${gitIdentity}`

export function projectLine(name: string, settings: Pick<ProjectSettings, 'company' | 'domain'>) {
  const scope = [
    settings.company ? `company ${settings.company}` : null,
    settings.domain ? `domain ${settings.domain}` : null
  ].filter(Boolean)
  return `Project: ${name}${scope.length ? ` (${scope.join(' · ')})` : ''}`
}

type Resolved =
  | { state: 'inherited' | 'unverified'; item: SessionContextAttachment }
  | { state: 'not-on-host'; hostId: string | null }

function resolveAttachment(item: SessionContextAttachment, host: ProjectLaunchHost): Resolved {
  if (item.kind === 'skill') {
    if (item.uri && item.hostId === host.hostId) {
      return { state: 'inherited', item }
    }
    // Why by name: a skill's portable form is its name; each computer has its own copy.
    const found = host.skill(item.title)
    if (found === 'unknown') {
      const { uri: _uri, ...byName } = item
      return { state: 'unverified', item: { ...byName, hostId: host.hostId } }
    }
    return found
      ? { state: 'inherited', item: { ...item, uri: found.path, hostId: host.hostId } }
      : { state: 'not-on-host', hostId: item.hostId ?? null }
  }
  if (item.kind === 'file' || item.kind === 'folder') {
    if ((item.hostId ?? 'local') === host.hostId) {
      return { state: 'inherited', item }
    }
    const copy = item.repo ? checkoutCopy(item.repo, host) : null
    return copy
      ? { state: 'inherited', item: { ...item, uri: copy, hostId: host.hostId } }
      : { state: 'not-on-host', hostId: item.hostId ?? 'local' }
  }
  return { state: 'inherited', item }
}

/** A repo file's path in this host's own checkout of that repo, or null when it has none. */
function checkoutCopy(
  repo: NonNullable<SessionContextAttachment['repo']>,
  host: ProjectLaunchHost
): string | null {
  const checkout = host.repoCheckout(repo.gitIdentity)
  if (!checkout) {
    return null
  }
  const path = resolveRuntimePath(checkout, repo.path)
  // Why: a stored path that climbs out of the checkout is not that repo's file.
  return isPathInsideOrEqual(checkout, path) ? path : null
}

function repoAttachment(gitIdentity: string, path: string, host: ProjectLaunchHost) {
  return {
    id: projectRepoItemId(gitIdentity),
    kind: 'folder' as const,
    title: `Repo ${gitIdentity}`,
    uri: path,
    hostId: host.hostId
  }
}

/** The project's agent for this launch: its default, or its copy of the template the launcher chose. */
export function projectAgentForLaunch(
  agents: readonly ProjectAgent[],
  templateId: string | null
): ProjectAgent | null {
  if (!templateId || templateId === AGENT_TEMPLATE_DEFAULT_ID) {
    return agents[0] ?? null
  }
  return agents.find((agent) => agent.templateId === templateId) ?? null
}

export function resolveProjectLaunch(input: ProjectLaunchInput): ProjectLaunchResolution {
  const { project, host } = input
  const { settings } = project
  const removed = new Set(input.removed)
  const inherited: InheritedItem[] = []
  const notOnHost: NotOnHostItem[] = []
  const fromProject: SessionContextAttachment[] = []
  const take = (
    base: Pick<InheritedItem, 'id' | 'kind' | 'title'>,
    resolved: Resolved | { state: 'repo-missing' }
  ) => {
    const replacement = input.replaced?.[base.id]
    if (removed.has(base.id)) {
      inherited.push({ ...base, state: 'removed' })
    } else if (resolved.state === 'inherited' || resolved.state === 'unverified') {
      const repo = base.kind === 'repo' ? undefined : resolved.item.repo?.gitIdentity
      inherited.push({ ...base, state: resolved.state, ...(repo ? { repo } : {}) })
      fromProject.push(resolved.item)
    } else if (replacement) {
      inherited.push({ ...base, state: 'replaced' })
      fromProject.push(replacement)
    } else {
      const hostId = resolved.state === 'not-on-host' ? resolved.hostId : null
      inherited.push({ ...base, state: 'not-on-host', ...(hostId ? { hostId } : {}) })
      notOnHost.push({ ...base, hostId })
    }
  }
  for (const repo of settings.repos) {
    const path = host.repoCheckout(repo.gitIdentity)
    const base = { id: projectRepoItemId(repo.gitIdentity), kind: 'repo' as const }
    const title = repo.gitIdentity
    take(
      { ...base, title },
      path
        ? { state: 'inherited', item: repoAttachment(repo.gitIdentity, path, host) }
        : { state: 'repo-missing' }
    )
  }
  for (const item of settings.attachments) {
    take({ id: item.id, kind: item.kind, title: item.title }, resolveAttachment(item, host))
  }
  // Later layers win an id: the target's launch context, then the session's own additions.
  const merged = new Map<string, SessionContextAttachment>()
  for (const item of [...fromProject, ...input.launch, ...input.session]) {
    merged.delete(item.id)
    merged.set(item.id, item)
  }
  for (const id of removed) {
    merged.delete(id)
  }
  const attachments = [...merged.values()]
  let error: string | null = null
  try {
    validateSessionContext(attachments)
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason)
  }
  return {
    projectLine: projectLine(project.name, settings),
    attachments,
    inherited,
    notOnHost,
    agent: projectAgentForLaunch(settings.agents, input.templateId),
    roster: settings.agents.map(({ templateId, name }) => ({ templateId, name })),
    error
  }
}

/** What a project launch resolved to, as main, the CLI and the window each hold it. */
export type ProjectLaunchParts = Pick<
  ProjectLaunchResolution,
  'projectLine' | 'attachments' | 'inherited' | 'notOnHost' | 'agent'
> & {
  project: { folderId: string; name: string }
  /** Optional on the wire: an older window omits it. */
  roster?: ProjectLaunchResolution['roster']
}

/**
 * The launch list for a session started in a project: its line, the project's agent (unless the
 * caller already chose a template, `agent: false`), the roster as a pointer, and every inherited
 * item marked with where it came from. The opening message is built only from this.
 */
export function projectLaunchManifest(
  launch: ProjectLaunchParts,
  options: {
    prompt: string
    hostLabel: string | null
    agent?: LaunchManifest['agent'] | false
    folder?: LaunchManifest['folder']
  }
): LaunchManifest {
  const fromProject = new Set(
    launch.inherited.filter((item) => item.state !== 'removed').map((item) => item.id)
  )
  const attachments = dedupeLaunchAttachments(launch.attachments)
  const sources: Record<string, LaunchManifestSource> = {}
  for (const item of attachments) {
    sources[item.id] = fromProject.has(item.id) ? 'project' : 'workspace'
  }
  const projectAgent = launch.agent
    ? {
        templateId: launch.agent.templateId,
        name: launch.agent.name,
        digest: launch.agent.digest,
        instructions: launch.agent.instructions,
        from: 'project' as const
      }
    : null
  const agent = options.agent === false ? null : (options.agent ?? projectAgent)
  return {
    prompt: options.prompt,
    project: {
      folderId: launch.project.folderId,
      name: launch.project.name,
      line: launch.projectLine,
      roster: launch.roster ?? [],
      pointer: true
    },
    agent,
    attachments,
    sources,
    notOnHost: launch.notOnHost.map(({ id, kind, title }) => ({ id, kind, title })),
    hostLabel: options.hostLabel,
    folder: options.folder ?? null
  }
}

/** The opening message for a project launch; see launchManifestPrompt for the order. */
export function projectLaunchPrompt(
  launch: ProjectLaunchParts,
  options: Parameters<typeof projectLaunchManifest>[1]
): string {
  return launchManifestPrompt(projectLaunchManifest(launch, options))
}

export function describeNotOnHost(items: readonly NotOnHostItem[], hostLabel: string): string[] {
  return items.map((item) => `Not on ${hostLabel}: ${item.title} (left out of this session)`)
}
