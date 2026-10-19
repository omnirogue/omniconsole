/* eslint-disable max-lines */
/**
 * The person's own organization changes from the sidebar and work surfaces, each one recorded
 * change through the change path (applied first, recorded after; a record failure only toasts).
 * Remote archives wait for the owning computer's recorded change before reporting success.
 */

import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import type {
  OrganizationChangeKind,
  OrganizationExecutor,
  OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  applyPersonOrganizationChange,
  recordPersonOrganizationChange,
  windowOrganizationStores,
  type OrganizationChangeDeps
} from './session-organization-change'
import { resolveAgentTemplates } from '../../../shared/agent-templates'
import { getRepoGitIdentity } from '../../../shared/folder-workspace-attached-repos'
import {
  projectAgentFor,
  withProjectCoordinator,
  type ProjectAgent,
  type ProjectRepo,
  type ProjectSettings
} from '../../../shared/project-settings'
import { noteSessionFolderEdit } from './account-sync/session-organization-intent'
import { conversationViewKey } from './conversation-view'
import type { SessionFolderColor } from './session-folder-colors'
import type { SessionFolderSection } from './session-folder-tree'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import { sessionFolderGroupKey } from './session-sidebar-view'
import { archiveOnSessionOwner, hasRemoteSessionOwner } from './session-owner-archive'
import { isMirroredConversationLedgerKey } from './mirrored-sidebar-conversation'
import { movableSessionKeys } from './session-move-owner-guard'
import { buildSidebarSessions } from './sidebar-sessions'

export type PersonSurface = Extract<OrganizationExecutor, { kind: 'person' }>['via']
export type PersonChangeOptions = { via?: PersonSurface; deps?: OrganizationChangeDeps }

function applyByPerson(
  kind: OrganizationChangeKind,
  targets: OrganizationTarget[],
  value: unknown,
  options: PersonChangeOptions
): boolean {
  if (targets.length === 0) {
    return true
  }
  const { outcome } = applyPersonOrganizationChange(
    { kind, targets, value, executor: { kind: 'person', via: options.via ?? 'sidebar' } },
    options.deps
  )
  return outcome.status === 'applied' && !outcome.error
}

const sessionTargets = (keys: readonly string[]): OrganizationTarget[] =>
  [...new Set(keys.filter(Boolean))].map((sessionKey) => ({ sessionKey }))

/**
 * Files sessions in a folder (`saved-sessions` for the Saved root, null for unfiled). Rows a
 * paired owner places are refused with "Open it on <Computer>" and the rest still move; false
 * when nothing could.
 */
export function moveSessionsByPerson(
  keys: readonly string[],
  folderId: string | null,
  options: PersonChangeOptions = {}
): boolean {
  const movable = movableSessionKeys(keys)
  if (movable.length === 0 && keys.length > 0) {
    return false
  }
  return applyByPerson('move', sessionTargets(movable), folderId, options)
}

export async function archiveSessionsByPerson(
  keys: readonly string[],
  archived: boolean,
  options: PersonChangeOptions = {}
): Promise<boolean> {
  const unique = [...new Set(keys)]
  const remote = unique.filter(hasRemoteSessionOwner)
  const local = unique.filter((key) => !hasRemoteSessionOwner(key))
  const applied = applyByPerson(
    archived ? 'archive' : 'unarchive',
    sessionTargets(local),
    archived,
    options
  )
  const confirmed = await Promise.all(
    remote.map((key) => archiveOnSessionOwner(key, archived, options.deps?.rpc))
  )
  return applied && confirmed.every(Boolean)
}

/** Deletes rows from the list (or brings them back); tabs are closed by the caller. */
export function deleteSessionsByPerson(
  keys: readonly string[],
  deleted: boolean,
  options: PersonChangeOptions = {}
): boolean {
  // Why (session parity, step 7): a ledger row's conversation runs on its paired owner, so it is
  // deleted there; the callers refuse such rows, and an undo may still bring one back.
  const targets = deleted ? keys.filter((key) => !isMirroredConversationLedgerKey(key)) : keys
  return applyByPerson('delete', sessionTargets(targets), deleted, options)
}

/** Hides rows from the list (or shows them again); per device. */
export function hideSessionsByPerson(
  keys: readonly string[],
  hidden: boolean,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson(hidden ? 'hide' : 'unhide', sessionTargets(keys), hidden, options)
}

/**
 * Gives rows a tag (or takes it away). `automaticTag` is the tag a row shows with none chosen
 * (its company), so a first choice keeps it.
 */
export function tagSessionsByPerson(
  keys: readonly string[],
  tagId: string,
  tagged: boolean,
  options: PersonChangeOptions & { automaticTag?: (sessionKey: string) => string | null } = {}
): boolean {
  const { automaticTag, ...rest } = options
  const stores = rest.deps?.stores ?? windowOrganizationStores()
  return applyByPerson(tagged ? 'tag' : 'untag', sessionTargets(keys), tagId, {
    ...rest,
    deps: { ...rest.deps, stores: automaticTag ? { ...stores, automaticTag } : stores }
  })
}

/** Puts rows away until a time (epoch ms), or brings them back now with null. */
export function snoozeSessionsByPerson(
  keys: readonly string[],
  until: number | null,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('snooze', sessionTargets(keys), until, options)
}

export function moveFolderByPerson(
  folderId: string,
  parentId: string | null,
  section?: SessionFolderSection,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson(
    'folder.move',
    [{ folderId }],
    { parentId, ...(section ? { section } : {}) },
    options
  )
}

export function renameFolderByPerson(
  folderId: string,
  name: string,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('folder.rename', [{ folderId }], name.trim(), options)
}

/** A color for a folder group or the Saved root, keyed by its sidebar group key. */
export function colorFolderGroupByPerson(
  groupKey: string,
  color: SessionFolderColor | null,
  options: PersonChangeOptions = {}
): boolean {
  const prefix = sessionFolderGroupKey('')
  const folderId =
    groupKey === SAVED_SESSIONS_FOLDER_ID
      ? groupKey
      : groupKey.startsWith(prefix)
        ? groupKey.slice(prefix.length)
        : null
  if (!folderId) {
    return false
  }
  return applyByPerson('folder.color', [{ folderId }], color, options)
}

const foldersOf = (options: PersonChangeOptions) =>
  options.deps?.stores?.folders ?? useSessionFolders

function folderShape(folder: SessionFolder): Record<string, unknown> {
  return {
    name: folder.name,
    parentId: folder.parentId ?? null,
    section: folder.section === 'saved' ? 'saved' : 'active'
  }
}

/**
 * Creates a folder; its id, or null when the store refused (its error says why). With `project`,
 * the folder and its settings are one edit and one recorded `folder.create` carrying them.
 */
export function createFolderByPerson(
  name: string,
  section?: 'saved',
  parentId?: string,
  options: PersonChangeOptions & { project?: ProjectSettings } = {}
): string | null {
  const store = foldersOf(options)
  const id = store.getState().createFolder(name, section, parentId, options.project)
  const created = id
    ? store.getState().metadata.folders.find((folder) => folder.id === id)
    : undefined
  if (id && created) {
    const project = store.getState().metadata.projects?.[id]
    const shape = { ...folderShape(created), ...(project ? { project } : {}) }
    recordPersonOrganizationChange(
      {
        kind: 'folder.create',
        targets: [{ folderId: id }],
        value: shape,
        executor: { kind: 'person', via: options.via ?? 'sidebar' }
      },
      { before: [null], after: [shape] },
      options.deps
    )
  }
  return id
}

/**
 * Saves a project folder's settings, or removes them with null, as one recorded `folder.project`
 * change Undo can put back; false when the store refused (its error says why).
 */
export function setProjectSettingsByPerson(
  folderId: string,
  settings: ProjectSettings | null,
  options: PersonChangeOptions = {}
): boolean {
  return applyByPerson('folder.project', [{ folderId }], settings, options)
}

/** Deletes a folder (its sessions are kept); false when the store refused. */
export function deleteFolderByPerson(folderId: string, options: PersonChangeOptions = {}): boolean {
  const store = foldersOf(options)
  const folder = store.getState().metadata.folders.find((entry) => entry.id === folderId)
  if (!folder || !store.getState().deleteFolder(folderId)) {
    return false
  }
  recordPersonOrganizationChange(
    {
      kind: 'folder.delete',
      targets: [{ folderId }],
      value: true,
      executor: { kind: 'person', via: options.via ?? 'sidebar' }
    },
    { before: [folderShape(folder)], after: [null] },
    options.deps
  )
  return true
}

function resolveBuiltinProjectAgents(ids: readonly string[]): ProjectAgent[] {
  const templates = resolveAgentTemplates(undefined)
  return ids
    .map((id) => templates.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => projectAgentFor(t))
    .filter((a): a is ProjectAgent => a !== null)
}

const autoFiledSessionKeys = new Set<string>()

function matchBuiltinRepos(pattern: RegExp, defaultGitIdentity: string): ProjectRepo[] {
  const seen = new Map<string, string>([
    [defaultGitIdentity.toLowerCase(), defaultGitIdentity.toLowerCase()]
  ])
  try {
    const repos = useAppStore.getState()?.repos ?? []
    for (const repo of repos) {
      if (repo.connectionId || !pattern.test(`${repo.displayName ?? ''} ${repo.path ?? ''}`)) {
        continue
      }
      const gitIdentity = getRepoGitIdentity(repo)
      if (gitIdentity && !gitIdentity.startsWith('path:')) {
        const key = gitIdentity.toLowerCase()
        if (!seen.has(key)) {
          seen.set(key, gitIdentity)
        }
      }
    }
  } catch {
    // ignore store read errors during early bootstrap
  }
  return [...seen.values()].map((gitIdentity) => ({ gitIdentity }))
}

/**
 * Ensures the 3 prebuilt Universal Projects (Reverse Engineer, Advertising, Customer Service)
 * exist in `useSessionFolders` with valid `ProjectSettings` (instructions, two-tier skills,
 * custom bots, memory & `.omni-project/project.json` bundle links) and files matching Mac Studio
 * sessions into them.
 */
export function ensureBuiltinUniversalProjects(): void {
  const store = useSessionFolders.getState()
  if (!store.loaded) {
    return
  }
  const now = 1792413217049
  const seeds: readonly {
    id: string
    name: string
    domain: string
    goal: string
    templateId: string
    agentIds: readonly string[]
    defaultGitIdentity: string
    repoPattern: RegExp
    sessionPattern: RegExp
    instructions: string
    skills: readonly string[]
    workspaceUri: string
    memoryUri: string
    bundleUri: string
  }[] = [
    {
      id: '7cf7cd75-4bac-4b2a-88c5-0c3e66f628bc',
      name: 'Reverse Engineer',
      domain: 'Reverse Engineering',
      goal: 'Reverse-engineer binaries, minified JS bundles, and undocumented HAR/mitmproxy APIs using the @zodchiii Opus 5.5 1M protocol, cross-verified by GPT-6 Astra and Grok 4.',
      templateId: 'reverse-engineer',
      agentIds: ['reverse-engineer', 'grok-bot'],
      defaultGitIdentity: 'github.com/omnirogue/omnidots-cloud',
      repoPattern: /reverse[-_\s]?engineer|omnidots-cloud|ghidra/i,
      sessionPattern:
        /reverse[-_\s]?engineer|zodchiii|ghidra|mitmproxy|kaitai|deobfuscat|audit omnidots-cloud|audit this omnidots-cloud/i,
      instructions:
        '# Reverse Engineer (@zodchiii Opus 5.5 1M Protocol)\n' +
        'Universal Project Bundle: ~/Work/Shared/Reverse-Engineering/.omni-project/project.json\n' +
        'Default-Loaded Skills (Tier 1): reverse-engineer\n' +
        'Callable Skills (Tier 2): omni-reuse-research, omni-boundary-review, omni-typescript-review\n' +
        '- Never modify ./target (read-only untrusted input).\n' +
        '- Tag every claim CONFIRMED or GUESS with file:line or hex offset.\n' +
        '- Redact live credentials before HAR/mitmproxy analysis.\n' +
        '- Write outputs to ./notes/ARCHITECTURE.md, ./notes/renames.md, ./notes/open-questions.md.',
      skills: [
        'reverse-engineer',
        'omni-reuse-research',
        'omni-boundary-review',
        'omni-typescript-review'
      ],
      workspaceUri: '/Users/maintainer/Work/Shared/Reverse-Engineering',
      memoryUri: '/Users/maintainer/Work/Shared/Reverse-Engineering/memory/LESSONS.md',
      bundleUri: '/Users/maintainer/Work/Shared/Reverse-Engineering/.omni-project/project.json'
    },
    {
      id: 'c793c507-0678-4c24-97f2-755e8a3ec0fe',
      name: 'Advertising',
      domain: 'Paid Acquisition & Creative',
      goal: 'Run daily Meta, Google, and ChatGPT ad checks, launch compliant creatives with FunnelKit SubID tracking, and reconcile platform conversions against real Stripe + FunnelKit cash.',
      templateId: 'advertising',
      agentIds: ['advertising', 'grok-bot'],
      defaultGitIdentity: 'github.com/omnirogue/omnirogue',
      repoPattern: /advertising|marketing|adsmanager|roi-analysis|site-cro|betacorp/i,
      sessionPattern:
        /advertising|marketing|adsmanager|adops|meta ad|google ad|chatgpt ad|funnelkit|roi-analysis|site-cro|betacorp|a\/b test/i,
      instructions:
        '# Advertising (Meta, Google & ChatGPT Ads)\n' +
        'Universal Project Bundle: ~/Work/Shared/Advertising/.omni-project/project.json\n' +
        'Default-Loaded Skills (Tier 1): daily-ad-check, ad-launch-compliant, ad-prune-decide, revenue-truth-reconcile\n' +
        'Callable Skills (Tier 2): ad-campaign-create, ad-funnel-diagnosis, ad-creative-checkout, google-ads-daily, funnelkit-subid-enforce, funnelkit-lander-format\n' +
        '- Read ~/Work/Shared/Advertising/ACCOUNTS-AND-ACCESS.md and memory/LESSONS.md first.\n' +
        '- Reconcile ad platform conversions against real Stripe + FunnelKit cash.\n' +
        '- Enforce FunnelKit SubID and UTM tracking before launch; build new campaigns PAUSED.',
      skills: [
        'daily-ad-check',
        'ad-launch-compliant',
        'ad-prune-decide',
        'revenue-truth-reconcile',
        'ad-campaign-create',
        'ad-funnel-diagnosis',
        'ad-creative-checkout',
        'google-ads-daily',
        'funnelkit-subid-enforce',
        'funnelkit-lander-format'
      ],
      workspaceUri: '/Users/maintainer/Work/Shared/Advertising',
      memoryUri: '/Users/maintainer/Work/Shared/Advertising/memory/LESSONS.md',
      bundleUri: '/Users/maintainer/Work/Shared/Advertising/.omni-project/project.json'
    },
    {
      id: 'b9fcfc28-f02b-4fc6-9024-7083d6bf30e3',
      name: 'Customer Service',
      domain: 'Support Triage & Billing Forensics',
      goal: 'Triage ACME and OmniRogue customer tickets, run payment and cancellation forensics, and send ER2-sealed replies and approved refunds with zero hallucinated billing outcomes.',
      templateId: 'cs',
      agentIds: ['cs', 'grok-bot'],
      defaultGitIdentity: 'github.com/omnirogue/omnirogue',
      repoPattern: /customer\s*service|email[\s-_]*operations|email-replier|cs-1|cs-refresh/i,
      sessionPattern:
        /customer\s*service|email[\s-_]*operations|email-replier|complaint-fix|support-replies|cs-1|cs-refresh|fix-cs-|refund|alertguard|gatewayone/i,
      instructions:
        '# Customer Service & Email Operations\n' +
        'Universal Project Bundle: ~/Work/Shared/Email Operations/.omni-project/project.json\n' +
        'Default-Loaded Skills (Tier 1): cs-ticket-triage, cc-refund, payment-forensics\n' +
        'Callable Skills (Tier 2): cc-cancellation-audit, rebill-schedule, alertguard-refund-loop, email-inbox-triage\n' +
        '- Read ~/Work/Shared/Email Operations/AGENTS.md and memory/LESSONS.md first.\n' +
        '- Send only through ER2 with seal + send-check + readback.\n' +
        '- Refunds require per-case human approval on OmniOS Decisions within the 14-day / 5-generation rules.',
      skills: [
        'cs-ticket-triage',
        'cc-refund',
        'payment-forensics',
        'cc-cancellation-audit',
        'rebill-schedule',
        'alertguard-refund-loop',
        'email-inbox-triage'
      ],
      workspaceUri: '/Users/maintainer/Work/Shared/Email Operations',
      memoryUri: '/Users/maintainer/Work/Shared/Email Operations/memory/LESSONS.md',
      bundleUri: '/Users/maintainer/Work/Shared/Email Operations/.omni-project/project.json'
    }
  ]

  const current = store.metadata
  let changed = false
  const nextFolders = [...current.folders]
  const nextMembership: Record<string, string> = { ...current.membership }
  const nextProjects: Record<string, ProjectSettings> = { ...current.projects }
  const resolvedFolderIdBySeedId = new Map<string, string>()

  const defaultFleet = [
    {
      agent: 'claude' as const,
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      team: true,
      role: 'Lead Architect & Verifier'
    },
    {
      agent: 'codex' as const,
      model: 'gpt-6-astra',
      effort: 'xhigh',
      team: true,
      role: 'Deep Implementation & Systems'
    },
    {
      agent: 'grok' as const,
      model: 'grok-4',
      effort: 'high',
      role: 'Adversarial Audit & Edge Cases'
    }
  ]

  for (const seed of seeds) {
    let folder = nextFolders.find(
      (entry) =>
        entry.id === seed.id ||
        (!entry.parentId &&
          entry.section !== 'saved' &&
          entry.name.trim().toLowerCase() === seed.name.toLowerCase())
    )
    if (!folder) {
      folder = { id: seed.id, name: seed.name }
      nextFolders.push(folder)
      changed = true
    }
    resolvedFolderIdBySeedId.set(seed.id, folder.id)
    const matchedRepos = matchBuiltinRepos(seed.repoPattern, seed.defaultGitIdentity)
    const existingProject = nextProjects[folder.id]
    if (!existingProject) {
      const baseSettings: ProjectSettings = {
        repos: matchedRepos,
        attachments: [
          {
            id: `instructions:${seed.templateId}`,
            kind: 'instructions',
            title: seed.instructions.split('\n')[0]!.slice(0, 100),
            content: seed.instructions
          },
          {
            id: `folder:${seed.templateId}-workspace`,
            kind: 'folder',
            title: `${seed.name} Workspace`,
            uri: seed.workspaceUri
          },
          {
            id: `file:${seed.templateId}-memory`,
            kind: 'file',
            title: 'memory/LESSONS.md',
            uri: seed.memoryUri
          },
          {
            id: `file:${seed.templateId}-bundle`,
            kind: 'file',
            title: '.omni-project/project.json',
            uri: seed.bundleUri
          },
          ...seed.skills.map((skill) => ({
            id: `skill-name:${skill}`,
            kind: 'skill' as const,
            title: skill
          }))
        ],
        agents: resolveBuiltinProjectAgents(seed.agentIds),
        hostPolicy: 'as-named',
        company: 'OmniRogue',
        domain: seed.domain,
        goal: seed.goal,
        threadDefaults: {
          agent: 'claude',
          model: 'claude-opus-5-5',
          effort: 'high',
          team: true,
          templateId: seed.templateId
        },
        multiThreadFleet: defaultFleet,
        createdBy: 'person',
        createdAt: now,
        updatedAt: now
      }
      nextProjects[folder.id] = withProjectCoordinator(baseSettings, {
        launch: {
          agent: 'claude',
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          team: true,
          templateId: seed.templateId
        }
      })
      changed = true
    } else {
      let updatedProject = existingProject
      if (!updatedProject.goal) {
        updatedProject = { ...updatedProject, goal: seed.goal }
        changed = true
      }
      if (!updatedProject.threadDefaults) {
        updatedProject = {
          ...updatedProject,
          threadDefaults: {
            agent: 'claude',
            model: 'claude-opus-5-5',
            effort: 'high',
            team: true,
            templateId: seed.templateId
          }
        }
        changed = true
      }
      if (!updatedProject.multiThreadFleet || updatedProject.multiThreadFleet.length === 0) {
        updatedProject = {
          ...updatedProject,
          multiThreadFleet: defaultFleet
        }
        changed = true
      }
      if (
        matchedRepos.some(
          (repo) =>
            !updatedProject.repos.some(
              (existing) => existing.gitIdentity.toLowerCase() === repo.gitIdentity.toLowerCase()
            )
        )
      ) {
        const existingIdentities = new Set(
          updatedProject.repos.map((r) => r.gitIdentity.toLowerCase())
        )
        updatedProject = {
          ...updatedProject,
          repos: [
            ...updatedProject.repos,
            ...matchedRepos.filter((r) => !existingIdentities.has(r.gitIdentity.toLowerCase()))
          ]
        }
        changed = true
      }
      nextProjects[folder.id] = updatedProject
    }
  }

  try {
    const appState = useAppStore.getState()
    const sessions = buildSidebarSessions(appState)
    const activeByFolder = new Map<string, typeof sessions>()
    for (const session of sessions) {
      if (session.hostId && session.hostId !== 'local') {
        continue
      }
      const viewKey = conversationViewKey(session)
      if (!viewKey) {
        continue
      }
      let assignedFolder = nextMembership[viewKey]
      if (!assignedFolder && !autoFiledSessionKeys.has(viewKey)) {
        const haystack = [
          session.worktreeId,
          session.workspaceLabel,
          session.label,
          session.customTitle ?? ''
        ].join(' ')
        const matchedSeed = seeds.find((seed) => seed.sessionPattern.test(haystack))
        if (matchedSeed) {
          const folderId = resolvedFolderIdBySeedId.get(matchedSeed.id) ?? matchedSeed.id
          nextMembership[viewKey] = folderId
          assignedFolder = folderId
          autoFiledSessionKeys.add(viewKey)
          changed = true
        }
      }
      if (assignedFolder && nextProjects[assignedFolder]) {
        const list = activeByFolder.get(assignedFolder) ?? []
        list.push(session)
        activeByFolder.set(assignedFolder, list)
      }
    }

    // Synchronize per-thread memory index for every project folder (preserving deleted threads!)
    for (const [folderId, project] of Object.entries(nextProjects)) {
      const folderSessions = activeByFolder.get(folderId) ?? []
      const existingMemories = project.threadMemories ?? []
      if (folderSessions.length === 0 && existingMemories.length === 0) {
        continue
      }
      const workspaceAttachment = project.attachments.find((a) => a.kind === 'folder' && a.uri)
      const workspaceRoot = workspaceAttachment?.uri ?? `/Users/maintainer/Work/Shared/${folderId}`
      const activeIds = new Set<string>()
      const byId = new Map(existingMemories.map((m) => [m.threadId, m]))
      let memChanged = false

      for (const session of folderSessions) {
        const viewKey = conversationViewKey(session)
        if (!viewKey) {
          continue
        }
        const safeId = viewKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
        activeIds.add(safeId)
        const title = (session.customTitle ?? session.label ?? safeId).slice(0, 180)
        const agent = (session.agent ?? 'claude').slice(0, 64)
        const paneEntry = session.paneKey
          ? appState.agentStatusByPaneKey?.[session.paneKey]
          : undefined
        const status = (paneEntry?.state ?? 'idle').slice(0, 32)
        const memoryPath = `${workspaceRoot}/.omni-project/memory/threads/${safeId}.md`
        const outputTxtPath = `${workspaceRoot}/.omni-project/transcripts/${safeId}/Output.txt`
        const prev = byId.get(safeId)
        const summary = (
          prev?.summary ||
          `Thread "${title}" (${agent}) in ${session.workspaceLabel || 'project workspace'}. Clean Output.txt transcript (without tool calls) and per-thread memory persisted in .omni-project.`
        ).slice(0, 500)
        if (
          !prev ||
          prev.title !== title ||
          prev.status !== status ||
          prev.deletedFromUi === true
        ) {
          byId.set(safeId, {
            threadId: safeId,
            title,
            agent,
            ...(prev?.model ? { model: prev.model } : {}),
            ...(prev?.effort ? { effort: prev.effort } : {}),
            status,
            deletedFromUi: false,
            updatedAt: prev?.updatedAt ?? now,
            summary,
            outputTxtPath,
            memoryPath
          })
          memChanged = true
        }
      }

      // Mark any previously recorded thread memory that is no longer in active sessions as deletedFromUi: true (memory survives!)
      for (const [id, mem] of byId.entries()) {
        if (!activeIds.has(id) && !mem.deletedFromUi) {
          byId.set(id, { ...mem, deletedFromUi: true, status: 'deleted-preserved' })
          memChanged = true
        }
      }

      if (memChanged) {
        const sorted = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
        nextProjects[folderId] = {
          ...project,
          threadMemories: sorted
        }
        changed = true
      }
    }
  } catch {
    // Partial store doubles in unit tests may not have full session slices.
  }

  if (changed) {
    const nextMetadata = {
      ...current,
      folders: nextFolders,
      membership: nextMembership,
      projects: nextProjects
    }
    if (store.replaceMetadata(nextMetadata)) {
      noteSessionFolderEdit(current, nextMetadata)
    }
  }
}
