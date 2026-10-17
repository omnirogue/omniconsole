import { sessionContextText, type SessionContextAttachment } from './session-context-attachments'

/**
 * Everything a launch attaches, as one list (Sal, 2026-09-30: "we should always see through the UI
 * what agents, folder, context, etc is attached so we can correct it"). The desktop review panel,
 * Session details and `omni session launch --dry-run` all show this list, and the opening message
 * is built only from it, so nothing reaches a session that the list did not name.
 */

export type LaunchManifestAgent = {
  templateId: string
  name: string
  /** Sent as part of the opening message; empty for a template without instructions. */
  instructions: string
  /** The stored text's digest; dropped when the person edits the text for this launch. */
  digest?: string
  from: 'project' | 'launcher'
}

export type LaunchManifestProject = {
  folderId: string
  name: string
  /** "Project: <name> (company · domain)", the message's first line. */
  line: string
  /** Every project agent; the ones the session does not run as are named as subagents, never their text. */
  roster: { templateId: string; name: string }[]
  /** False when the person removed the pointer paragraph for this launch. */
  pointer: boolean
}

export type LaunchManifestSource = 'project' | 'workspace' | 'session'

export type LaunchManifest = {
  /** The person's own task text; may be empty. */
  prompt: string
  project: LaunchManifestProject | null
  agent: LaunchManifestAgent | null
  attachments: SessionContextAttachment[]
  /** Where each attachment came from, by id; absent means the person added it. */
  sources: Record<string, LaunchManifestSource>
  /** Project items the target lacks: listed, never sent. */
  notOnHost: { id: string; kind: string; title: string }[]
  hostLabel: string | null
  /** The sidebar folder the session is filed in; a label only, it sends nothing. */
  folder: { id: string; name: string } | null
  /** Provider flags passed as given (CLI `--agent-args`), shown because they can carry a system prompt. */
  agentArgs?: string
}

export function emptyLaunchManifest(prompt = ''): LaunchManifest {
  return {
    prompt,
    project: null,
    agent: null,
    attachments: [],
    sources: {},
    notOnHost: [],
    hostLabel: null,
    folder: null
  }
}

function attachmentIdentity(item: SessionContextAttachment): string {
  return JSON.stringify([item.kind, (item.content ?? '').trim() || item.uri || item.title])
}

/** Drops an attachment identical to an earlier one (a brief saved on both the project and the workspace). */
export function dedupeLaunchAttachments(
  items: readonly SessionContextAttachment[]
): SessionContextAttachment[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = attachmentIdentity(item)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** What is sent: duplicates dropped, and a brief identical to the agent's own text sent once. */
export function sentLaunchAttachments(manifest: LaunchManifest): SessionContextAttachment[] {
  const agentText = manifest.agent?.instructions.trim()
  return dedupeLaunchAttachments(manifest.attachments).filter(
    (item) => !(agentText && item.kind === 'instructions' && item.content?.trim() === agentText)
  )
}

/** The project's agents other than the one this session runs as. */
function subagentNames(
  project: Pick<LaunchManifestProject, 'roster'>,
  agentTemplateId: string | null | undefined
): string[] {
  return project.roster
    .filter((item) => item.templateId !== agentTemplateId)
    .map((item) => item.name)
}

/** A short pointer the agent follows itself instead of receiving project details pasted in. */
export function projectPointerText(
  project: LaunchManifestProject,
  agentTemplateId: string | null | undefined
): string {
  const others = subagentNames(project, agentTemplateId)
  const roster = others.length
    ? ` Project agents you may use as subagents: ${others.join(', ')}; their instructions are in that command's --json output.`
    : ''
  return `Project “${project.name}”: when its company, domain, repos or agents matter, read them yourself with \`omni folder project --folder ${project.folderId}\` on the OmniConsole computer.${roster}`
}

/**
 * The opening message, built only from the manifest: the project line first (session titles skip
 * it), the task, the agent's instructions, the project pointer, then the attached context block.
 * A text block identical to an earlier one is sent once.
 */
export function launchManifestPrompt(manifest: LaunchManifest): string {
  const { project, agent } = manifest
  const parts = [
    project?.line,
    manifest.prompt,
    agent?.instructions,
    project?.pointer ? projectPointerText(project, agent?.templateId) : undefined,
    sessionContextText(sentLaunchAttachments(manifest))
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
  return [...new Set(parts)].join('\n\n')
}

/** True when a launch carries anything beyond the person's own text and the bare provider. */
export function launchManifestAttachesAnything(manifest: LaunchManifest): boolean {
  return Boolean(
    manifest.project ||
    manifest.folder ||
    manifest.agent?.instructions.trim() ||
    manifest.attachments.length ||
    manifest.notOnHost.length ||
    manifest.agentArgs
  )
}

const SOURCE_LABEL: Record<LaunchManifestSource, string> = {
  project: 'from project',
  workspace: 'from workspace',
  session: 'added'
}

export function launchAttachmentSource(
  manifest: Pick<LaunchManifest, 'sources'>,
  id: string
): string {
  return SOURCE_LABEL[manifest.sources[id] ?? 'session']
}

export type LaunchManifestRowKind =
  | 'folder'
  | 'project'
  | 'pointer'
  | 'agent'
  | 'flags'
  | 'task'
  | 'attachment'
  | 'not-sent'

/** One entry of the list, as the panel, Session details and the CLI each show it. */
export type LaunchManifestRow = {
  id: string
  kind: LaunchManifestRowKind
  label: string
  detail: string
}

export function launchManifestRows(report: LaunchManifestReport): LaunchManifestRow[] {
  const { project, agent } = report
  const rows: LaunchManifestRow[] = []
  const row = (id: string, kind: LaunchManifestRowKind, label: string, detail: string) =>
    rows.push({ id, kind, label, detail })
  if (report.folder) {
    row('folder', 'folder', 'Folder', `${report.folder.name} (sidebar filing only, sends nothing)`)
  }
  if (project) {
    row('project', 'project', 'Project line', project.line)
    if (project.pointer) {
      const others = subagentNames(project, agent?.templateId)
      const roster = others.length ? `; subagents named: ${others.join(', ')}` : ''
      row(
        'pointer',
        'pointer',
        'Project pointer',
        `omni folder project --folder ${project.folderId}${roster}`
      )
    }
  }
  row(
    'agent',
    'agent',
    'Agent',
    agent
      ? `${agent.name} (${agent.from === 'project' ? 'project agent' : 'launcher template'}${agent.instructionsChars ? `, ${agent.instructionsChars} characters of instructions` : ', no instructions'})`
      : 'none (provider default)'
  )
  if (report.agentArgs) {
    row('flags', 'flags', 'Provider flags', report.agentArgs)
  }
  const task = report.prompt.trim()
  row('task', 'task', 'Task', task ? task.split('\n')[0]!.slice(0, 120) : 'none typed')
  if (!report.attachments.length) {
    row('attachments', 'attachment', 'Attached', 'nothing')
  }
  for (const item of report.attachments) {
    row(
      item.id,
      'attachment',
      `Attached ${item.kind}`,
      `${item.title}${item.uri ? ` <${item.uri}>` : ''}${item.hostId ? ` on ${item.hostId}` : ''} (${launchAttachmentSource(report, item.id)})`
    )
  }
  for (const item of report.notOnHost) {
    row(
      `not-sent:${item.id}`,
      'not-sent',
      'Not sent',
      `${item.title} (${item.kind}) is not on ${report.hostLabel ?? 'this host'}`
    )
  }
  return rows
}

/** The list as plain lines, for the CLI. */
export function launchManifestLines(report: LaunchManifestReport): string[] {
  return launchManifestRows(report).map((row) => `${row.label}: ${row.detail}`)
}

/** The list without document bodies or instruction text: `--json` output and a session's record. */
export type LaunchManifestReport = Omit<LaunchManifest, 'attachments' | 'agent'> & {
  attachments: Omit<SessionContextAttachment, 'content'>[]
  agent:
    | (Omit<LaunchManifestAgent, 'instructions'> & {
        instructionsChars: number
      })
    | null
}

export type LaunchManifestRecord = LaunchManifestReport & {
  launchedAt: number
}

export function launchManifestReport(manifest: LaunchManifest): LaunchManifestReport {
  const { agent, attachments: _attachments, ...rest } = manifest
  return {
    ...rest,
    prompt: manifest.prompt.slice(0, 500),
    attachments: sentLaunchAttachments(manifest).map(({ content: _content, ...item }) => item),
    agent: agent
      ? {
          templateId: agent.templateId,
          name: agent.name,
          from: agent.from,
          instructionsChars: agent.instructions.trim().length
        }
      : null
  }
}
