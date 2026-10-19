import { z } from 'zod'
import type { InheritedItem, NotOnHostItem } from './project-launch-inheritance'
import type { ProjectCoordinator, ProjectSettings } from './project-settings'
import type { SessionProjectThreadStatus } from './session-project-thread-status'
import {
  SESSION_CONTEXT_MAX_ITEMS,
  sessionContextAttachmentSchema,
  type SessionContextAttachment
} from './session-context-attachments'

/**
 * The contract behind `omni folder project…` and project inheritance for CLI and dispatch
 * launches: main reads a project's settings from the window that keeps the folders, resolves them
 * for the target host, and never creates one (people make projects; agents may suggest one, Sal
 * 2026-09-01). All fields are additive; an older window answers these kinds with an error.
 */
export const SESSION_PROJECTS_RPC = {
  show: 'sessionProjects.show',
  suggest: 'sessionProjects.suggest',
  create: 'sessionProjects.create',
  resolveLaunch: 'sessionProjects.resolveLaunch',
  /** Keeps a CLI launch's inherited context on its tab, as the launcher does (plan §2d). */
  bindLaunch: 'sessionProjects.bindLaunch',
  /** Read-only: this computer's projects, for the CLI and paired desktops (upgrade plan PR 6). */
  list: 'sessionProjects.list'
} as const

export const SessionProjectListParamsSchema = z.object({}).strict()

const folderRef = z.string().trim().min(1).max(1000)

export const SessionProjectShowParamsSchema = z.object({ folder: folderRef }).strict()
export const SessionProjectSuggestParamsSchema = z
  .object({ folder: folderRef, reason: z.string().trim().min(1).max(500) })
  .strict()
export const SessionProjectCreateParamsSchema = z.object({ folder: folderRef }).passthrough()
export const SessionProjectResolveLaunchParamsSchema = z
  .object({
    folder: folderRef,
    /** The execution host the session will run on (`local`, `ssh:<id>`). */
    host: z.string().trim().min(1).max(512),
    /** The workspace id whose kept launch context joins the inheritance, when known. */
    worktreeId: z.string().trim().min(1).max(1000).optional(),
    /** The template the caller chose; absent or Default lets the project's default agent apply. */
    templateId: z.string().trim().min(1).max(64).optional()
  })
  .strict()

export const SessionProjectBindLaunchParamsSchema = z
  .object({
    terminal: z.string().trim().min(1).max(1000),
    items: z.array(sessionContextAttachmentSchema).min(1).max(SESSION_CONTEXT_MAX_ITEMS)
  })
  .strict()

/** Window requests; answered through the session-folder relay. */
export type SessionProjectRendererRequest =
  | { kind: 'readProject'; folder: string; worktreeId?: string }
  | { kind: 'suggestProject'; folder: string; by: string; reason: string }
  /** Every project in this window (`SessionProjectListResult`, without thread counts). */
  | { kind: 'listProjects' }
  /** The project a pane works in, as its project page counts threads (`SessionProjectForPane`). */
  | { kind: 'projectForPane'; paneKey: string }
  /** Keeps a launch's context on the tab main started, as the launcher does (`{ bound: true }`). */
  | {
      kind: 'bindLaunchContext'
      tabId: string
      worktreeId: string | null
      items: SessionContextAttachment[]
    }

export const SESSION_PROJECT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  'readProject',
  'listProjects',
  'suggestProject',
  'projectForPane',
  'bindLaunchContext'
])

/** A project's threads as its page counts them, the project chat apart. */
export type SessionProjectThreadCounts = {
  total: number
  byStatus: Partial<Record<SessionProjectThreadStatus | 'idle', number>>
  /** The project chat's status, when its coordinator is listed. */
  chat?: SessionProjectThreadStatus | 'idle'
}

export type SessionProjectListEntry = {
  folderId: string
  name: string
  path: string
  company?: string
  domain?: string
  repos: number
  /** How its chat launches; absent when the project has no coordinator. */
  coordinator?: ProjectCoordinator['launch']
  /** Null when the threads could not be counted; the project still lists. */
  threads: SessionProjectThreadCounts | null
}

export type SessionProjectListResult = { projects: SessionProjectListEntry[] }

/** Always carries `folderId`: an older window answers a kind it doesn't know with nothing. */
export type SessionProjectForPane = { folderId: string | null }

export type SessionProjectReadResult = {
  folder: { id: string; name: string; path: string }
  /** The project the folder is in (itself, or the one above it), or null. */
  project: {
    folderId: string
    name: string
    path: string
    settings: ProjectSettings | null
  } | null
  /** The workspace's kept (not one-shot) launch context in this window, when one was named. */
  launch?: SessionContextAttachment[]
}

export type SessionProjectLaunch = {
  project: { folderId: string; name: string }
  projectLine: string
  host: { id: string; label: string }
  /** What the session gets, in inheritance order, with its content. */
  attachments: SessionContextAttachment[]
  inherited: InheritedItem[]
  notOnHost: NotOnHostItem[]
  agent: { templateId: string; name: string; digest: string; instructions: string } | null
  /** Every project agent by name, for the session to use as subagents; absent from older windows. */
  roster?: { templateId: string; name: string }[]
  error: string | null
  /** Documents that kept their saved copy because a fresh read failed, as sentences. */
  notes?: string[]
}

/**
 * `orchestration worker-start`'s `project`: the project the worker inherited, or why it could not
 * be read. `filed` marks a worker sent in from outside the project; one whose launcher is in the
 * project stays unfiled and nests under it.
 */
export type WorkerProjectReceipt =
  | { folderId: string; name: string; notOnHost: string[]; filed?: true; notes?: string[] }
  | { notInherited: string }

/** What `--json` shows: the inherited list without document bodies. */
export function sessionProjectLaunchReport(launch: SessionProjectLaunch) {
  const { attachments, agent, ...rest } = launch
  return {
    ...rest,
    agent: agent ? { templateId: agent.templateId, name: agent.name, digest: agent.digest } : null,
    attachments: attachments.map(({ id, kind, title, uri, hostId }) => ({
      id,
      kind,
      title,
      ...(uri ? { uri } : {}),
      ...(hostId ? { hostId } : {})
    }))
  }
}

export const PROJECT_CREATE_REFUSED_AGENT =
  'A project is made by a person in OmniConsole, never by an agent. Nothing changed. Suggest one instead: omni folder project-suggest --folder <folder> --reason "<why>", and the person decides in the window.'
export const PROJECT_CREATE_REFUSED_CLI =
  'A project is made in OmniConsole: open the folder’s menu and choose "Set up as project…". The CLI cannot tell a person from an agent, so it never creates one. Nothing changed.'
