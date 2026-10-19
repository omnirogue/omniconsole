/* eslint-disable max-lines */
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { projectSettingsFor } from '@/lib/session-folders'
import {
  createFolderByPerson,
  setProjectSettingsByPerson
} from '@/lib/session-organization-person-changes'
import { useSessionFolders } from '@/store/session-folders'
import { SessionContextItemsEditor } from '@/components/session-context/SessionContextItemsEditor'
import { projectAttachmentForm, type ProjectSettings } from '../../../../shared/project-settings'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { isCompanyFolderName } from '../../../../shared/session-project-folder'
import {
  projectSettingsDraftFor,
  projectSettingsFromDraft,
  type ProjectSettingsDraft
} from './project-settings-draft'
import { closeProjectSettings, useProjectSettingsDialog } from './project-settings-dialog-store'
import { ProjectSettingsAgents } from './ProjectSettingsAgents'
import { ProjectSettingsComputers } from './ProjectSettingsComputers'
import { ProjectSettingsCoordinator } from './ProjectSettingsCoordinator'
import { ProjectSettingsMemoryTab } from './ProjectSettingsMemoryTab'
import { ProjectSettingsNotes } from './ProjectSettingsNotes'
import { ProjectSettingsRepos } from './ProjectSettingsRepos'
import { withRepoRelativePaths } from './project-attachment-repo'

const NO_COMPANY = 'none'

/** Mounted once; shows the dialog for whichever project folder `openProjectSettings` named. */
export function ProjectSettingsDialogHost(): React.JSX.Element | null {
  const folderId = useProjectSettingsDialog((state) => state.folderId)
  const create = useProjectSettingsDialog((state) => state.create)
  const folder = useSessionFolders((state) =>
    folderId ? state.metadata.folders.find((entry) => entry.id === folderId) : undefined
  )
  const existing = useSessionFolders((state) => projectSettingsFor(state.metadata, folderId))
  if (create) {
    return <ProjectSettingsDialog key="create" folderId={null} folderName="" existing={null} />
  }
  if (!folderId || !folder) {
    return null
  }
  // Why the key: each opening starts a fresh draft from what is saved then.
  return (
    <ProjectSettingsDialog
      key={folderId}
      folderId={folderId}
      folderName={folder.name}
      existing={existing}
    />
  )
}

function saveProjectSettings(folderId: string, settings: ProjectSettings | null): string | null {
  return setProjectSettingsByPerson(folderId, settings)
    ? null
    : (useSessionFolders.getState().error ??
        translate('projects.settings.saveFailed', 'Could not save the project settings.'))
}

/** The dialog's instructions become one `instructions` attachment, as the editor makes them. */
function instructionsAttachment(text: string): SessionContextAttachment | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return {
    id: `instructions:${crypto.randomUUID()}`,
    kind: 'instructions',
    title: trimmed.split('\n')[0]!.slice(0, 100),
    content: trimmed
  }
}

function ProjectSettingsDialog({
  folderId,
  folderName,
  existing
}: {
  /** Null while creating: the folder is made on Save, with the settings. */
  folderId: string | null
  folderName: string
  existing: ProjectSettings | null
}): React.JSX.Element {
  const create = folderId === null
  const [draft, setDraft] = useState<ProjectSettingsDraft>(() =>
    projectSettingsDraftFor(existing, useAppStore.getState().settings?.defaultTuiAgent)
  )
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState(NO_COMPANY)
  const [instructions, setInstructions] = useState('')
  const folders = useSessionFolders((state) => state.metadata.folders)
  // Why: a top-level folder named after a company holds projects (session-project-folder.ts).
  const companies = useMemo(
    () =>
      folders.filter(
        (folder) =>
          !folder.parentId && folder.section !== 'saved' && isCompanyFolderName(folder.name)
      ),
    [folders]
  )
  // Why the open workspace: files and folders are picked from a checkout, and keep its host.
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const idSuffix = folderId ?? 'new'
  const update = (patch: Partial<ProjectSettingsDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }))
  const save = () => {
    const trimmedName = name.trim()
    if (create && !trimmedName) {
      setError(translate('projects.create.nameRequired', 'Name the project.'))
      return
    }
    const added = create ? instructionsAttachment(instructions) : null
    const built = projectSettingsFromDraft(
      added ? { ...draft, attachments: [...draft.attachments, added] } : draft,
      existing,
      Date.now()
    )
    if (!built.ok) {
      setError(built.error)
      return
    }
    let targetId = folderId
    if (targetId === null) {
      targetId = createFolderByPerson(
        trimmedName,
        undefined,
        parentId === NO_COMPANY ? undefined : parentId,
        { via: 'sidebar', project: built.settings }
      )
      if (!targetId) {
        setError(
          useSessionFolders.getState().error ??
            translate('projects.create.folderFailed', 'Could not create the project folder.')
        )
        return
      }
    }
    const failure = create ? null : saveProjectSettings(targetId, built.settings)
    if (failure) {
      setError(failure)
      return
    }
    closeProjectSettings()
    if (create) {
      useAppStore.getState().openProjectPage(targetId)
    }
  }
  const remove = () => {
    if (folderId === null) {
      return
    }
    const failure = saveProjectSettings(folderId, null)
    if (failure) {
      setError(failure)
      return
    }
    closeProjectSettings()
  }
  const [activeTab, setActiveTab] = useState<'general' | 'memory'>('general')
  const workspaceAttachment = draft.attachments.find((a) => a.kind === 'folder' && a.uri)
  const workspaceRoot =
    workspaceAttachment?.uri ?? `/Users/maintainer/Work/Shared/${folderName || 'Project'}`

  return (
    <Dialog open onOpenChange={(open) => !open && closeProjectSettings()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl"
        data-project-settings={create ? 'create' : ''}
      >
        <DialogHeader>
          <DialogTitle>
            {create
              ? translate('projects.create.title', 'New project')
              : translate('projects.settings.title', 'Project settings · {{name}}', {
                  name: folderName
                })}
          </DialogTitle>
          <DialogDescription>
            {create
              ? translate(
                  'projects.create.description',
                  'Name it, choose where it lives, and attach what every thread starts with.'
                )
              : translate(
                  'projects.settings.description',
                  'Configure project goal, coordinator & thread models/efforts, per-thread memories, and clean Output.txt transcripts.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b pb-2">
          <button
            type="button"
            onClick={() => setActiveTab('general')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === 'general'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            General & Models
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            data-project-settings-memory-tab=""
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === 'memory'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <span>Memory & Output.txt</span>
            <span className="rounded-full bg-background/20 px-1.5 py-px text-[10px] tabular-nums">
              {draft.threadMemories.length}
            </span>
          </button>
        </div>

        {activeTab === 'memory' ? (
          <ProjectSettingsMemoryTab
            folderName={folderName}
            workspaceRoot={workspaceRoot}
            threadMemories={draft.threadMemories}
          />
        ) : null}

        <div className={activeTab === 'general' ? 'space-y-4' : 'hidden'}>
          {create ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="project-name-new" className="text-xs">
                    {translate('projects.create.name', 'Name')}
                  </Label>
                  <Input
                    id="project-name-new"
                    autoFocus
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={translate('projects.create.namePlaceholder', 'Checkout rewrite')}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="project-parent-new" className="text-xs">
                    {translate('projects.create.companyFolder', 'Company folder')}
                  </Label>
                  <Select
                    value={parentId}
                    onValueChange={(value) => {
                      setParentId(value)
                      const chosen = companies.find((folder) => folder.id === value)
                      update({ company: chosen?.name ?? '' })
                    }}
                  >
                    <SelectTrigger id="project-parent-new" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COMPANY}>
                        {translate('projects.create.noCompany', 'Top level')}
                      </SelectItem>
                      {companies.map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="project-instructions-new" className="text-xs">
                  {translate('projects.create.instructions', 'Instructions')}
                </Label>
                <Textarea
                  id="project-instructions-new"
                  rows={3}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={translate(
                    'projects.create.instructionsPlaceholder',
                    'What every thread in this project should know and do…'
                  )}
                />
              </div>
            </>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor={`project-goal-${idSuffix}`} className="text-xs">
              {translate('projects.settings.goal', 'Goal')}
            </Label>
            <Textarea
              id={`project-goal-${idSuffix}`}
              rows={2}
              maxLength={1000}
              value={draft.goal}
              onChange={(event) => update({ goal: event.target.value })}
              placeholder={translate(
                'projects.settings.goalPlaceholder',
                'Describe what this project is working to achieve…'
              )}
            />
          </div>

          <div className="grid gap-4 rounded-lg border bg-muted/20 p-3">
            <ProjectSettingsCoordinator
              id={`project-coordinator-${idSuffix}`}
              title={translate(
                'projects.settings.coordinatorModelTitle',
                'Coordinator model & effort (Main project chat)'
              )}
              value={draft.coordinator}
              running={Boolean(existing?.coordinator?.sessionKey)}
              onChange={(coordinator) => update({ coordinator })}
            />
            <div className="border-t pt-3">
              <ProjectSettingsCoordinator
                id={`project-thread-defaults-${idSuffix}`}
                title={translate(
                  'projects.settings.threadDefaultsTitle',
                  'Default Thread model & effort (Child threads)'
                )}
                help={translate(
                  'projects.settings.threadDefaultsHelp',
                  'Default provider, model, effort level, and Team/Subagent mode when spawning a single thread in this project. Use the Multi-Model Launcher on the project page to launch parallel threads across multiple models simultaneously.'
                )}
                value={draft.threadDefaults}
                running={false}
                onChange={(threadDefaults) => update({ threadDefaults })}
              />
            </div>
          </div>

          {/* Why re-stamp: a file picked before its repo was listed travels once the repo is. */}
          <ProjectSettingsRepos
            repos={draft.repos}
            onChange={(repos) =>
              update({ repos, attachments: withRepoRelativePaths(draft.attachments, repos) })
            }
          />
          <SessionContextItemsEditor
            items={draft.attachments}
            worktreeId={activeWorktreeId}
            title={translate('projects.settings.attachments', 'Attachments')}
            help={translate(
              'projects.settings.attachmentsHelp',
              'Search and click to add. Skills are kept by name, so each computer uses its own copy.'
            )}
            onChange={async (next) =>
              update({
                attachments: withRepoRelativePaths(next.map(projectAttachmentForm), draft.repos)
              })
            }
          />
          <ProjectSettingsNotes
            attachments={draft.attachments}
            onChange={(attachments) => update({ attachments })}
          />
          <ProjectSettingsAgents agents={draft.agents} onChange={(agents) => update({ agents })} />
          <ProjectSettingsComputers
            mode={draft.hostMode}
            hosts={draft.hosts}
            onChange={(next) => update(next)}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`project-company-${idSuffix}`} className="text-xs">
                {translate('projects.settings.company', 'Company')}
              </Label>
              <Input
                id={`project-company-${idSuffix}`}
                maxLength={80}
                value={draft.company}
                onChange={(event) => update({ company: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`project-domain-${idSuffix}`} className="text-xs">
                {translate('projects.settings.domain', 'Domain')}
              </Label>
              <Input
                id={`project-domain-${idSuffix}`}
                maxLength={80}
                value={draft.domain}
                onChange={(event) => update({ domain: event.target.value })}
              />
            </div>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                {translate(
                  'projects.settings.universalBundleTitle',
                  'Universal Project Format (.omni-project/ v0.1.0 + Per-Thread Memory & Output.txt)'
                )}
              </span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                MCP Ready
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {translate(
                'projects.settings.universalBundleHelp',
                'Projects materialize canonical .omni-project/ bundles (project.json, instructions/project.md, memory/threads/<id>.md, transcripts/<id>/Output.txt without tool calls, pinned skills & bots) plus native AGENTS.md, CLAUDE.md, and GEMINI.md projections. Use omni-projects MCP tools to transfer projects, per-thread memories, and skills across OmniConsole, Claude, Codex, Grok Bot, Kimi, and Gemini.'
              )}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {existing && folderId !== null ? (
            confirmRemove ? (
              <div className="flex items-center gap-2 text-xs" data-project-settings-remove="">
                <span>
                  {translate(
                    'projects.settings.removeConfirm',
                    'Remove these settings? The folder and its sessions stay.'
                  )}
                </span>
                <Button type="button" variant="destructive" size="xs" onClick={remove}>
                  {translate('projects.settings.removeConfirmAction', 'Remove')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setConfirmRemove(false)}
                >
                  {translate('projects.settings.removeKeep', 'Keep')}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setConfirmRemove(true)}
              >
                {translate('projects.settings.remove', 'Remove project settings')}
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={closeProjectSettings}>
              {translate('projects.settings.cancel', 'Cancel')}
            </Button>
            <Button type="button" size="sm" onClick={save} data-project-settings-save="">
              {create
                ? translate('projects.create.save', 'Create project')
                : translate('projects.settings.save', 'Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
