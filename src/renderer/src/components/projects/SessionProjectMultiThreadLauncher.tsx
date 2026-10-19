/* eslint-disable max-lines */
import React, { useState } from 'react'
import {
  ArchiveRestore,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Layers,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Users
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { fileLaunchInFolder } from '@/lib/pending-folder-launches'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { setProjectSettingsByPerson } from '@/lib/session-organization-person-changes'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  ProjectSettings,
  ProjectThreadLaunch,
  ProjectThreadMemory
} from '../../../../shared/project-settings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { coordinatorLaunchPick, coordinatorViewMode } from './project-coordinator-launch'
import { openProjectSettings } from './project-settings-dialog-store'
import {
  COORDINATOR_AGENTS,
  coordinatorAgentOffersTeam,
  defaultMultiThreadFleet
} from './project-settings-draft'
import { useProjectFolderLaunch } from './use-project-folder-launch'

const MODEL_PRESETS_BY_AGENT: Record<string, readonly string[]> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-6-astra', 'o3-pro', 'codex-mini-latest'],
  grok: ['grok-4', 'grok-4-heavy', 'grok-3-mini'],
  kimi: ['moonshot-ai/kimi-k3', 'kimi-k2.5'],
  deepseek: [
    'deepseek-v4-pro',
    'deepseek-flash',
    'deepseek-v4.1',
    'deepseek-r2',
    'deepseek-v3.2',
    'deepseek-r1',
    'deepseek-chat',
    'deepseek-reasoner'
  ],
  gemini: ['gemini-3.1-pro', 'gemini-3.0-flash'],
  omp: ['omp-default']
}

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function SessionProjectMultiThreadLauncher({
  folder,
  settings,
  threads
}: {
  folder: SessionFolder
  settings: ProjectSettings | null
  threads: readonly SessionProjectThread[]
}): React.JSX.Element | null {
  const viewMode = useAppStore((state) => coordinatorViewMode(state.settings))
  const launch = useProjectFolderLaunch(folder, viewMode)

  const [fleetOpen, setFleetOpen] = useState(true)
  const [memoriesOpen, setMemoriesOpen] = useState(true)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  if (!settings) {
    return null
  }

  const fleet: ProjectThreadLaunch[] =
    settings.multiThreadFleet && settings.multiThreadFleet.length > 0
      ? settings.multiThreadFleet
      : defaultMultiThreadFleet()

  const workspaceAttachment = settings.attachments.find((a) => a.kind === 'folder' && a.uri)
  const workspaceRoot = workspaceAttachment?.uri ?? `~/Work/Shared/${folder.name}`

  const updateFleet = (nextFleet: ProjectThreadLaunch[]): void => {
    setProjectSettingsByPerson(
      folder.id,
      {
        ...settings,
        multiThreadFleet: nextFleet.slice(0, 8),
        updatedAt: Date.now()
      },
      { via: 'work' }
    )
  }

  const applyPreset = (preset: 'triad' | 'dual-teams' | 'council'): void => {
    if (preset === 'triad') {
      updateFleet(defaultMultiThreadFleet())
      toast.success('Loaded Triad Fleet: Claude Opus 5.5 + GPT-6 Astra + Grok 4')
      return
    }
    if (preset === 'dual-teams') {
      updateFleet([
        {
          agent: 'claude',
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          team: true,
          role: 'Claude Agent Team Lead'
        },
        {
          agent: 'codex',
          model: 'gpt-6-astra',
          effort: 'xhigh',
          team: true,
          role: 'Codex Subagent Swarm Lead'
        }
      ])
      toast.success('Loaded Dual Agent Teams: Claude Agent Teams + Codex Subagents')
      return
    }
    updateFleet([
      ...defaultMultiThreadFleet(),
      {
        agent: 'kimi',
        model: 'moonshot-ai/kimi-k3',
        effort: 'max',
        role: 'Kimi K3 Max Deep Verifier'
      }
    ])
    toast.success('Loaded 4-Model Council: Opus 5.5 + Astra + Grok 4 + Kimi K3')
  }

  const launchSingleSlot = (slot: ProjectThreadLaunch, index: number): void => {
    const pick = coordinatorLaunchPick({
      agent: slot.agent,
      ...(slot.model ? { model: slot.model } : {}),
      ...(slot.effort ? { effort: slot.effort } : {}),
      ...(slot.team ? { team: slot.team } : {}),
      ...(slot.templateId ? { templateId: slot.templateId } : {})
    })
    if (!pick) {
      toast.error(`Provider ${slot.agent} cannot be launched directly from here.`)
      return
    }
    const now = Date.now()
    const threadId = `thread-${slot.agent}-${now}-${index}`
    const memoryEntry: ProjectThreadMemory = {
      threadId,
      title: `${slot.role || 'Project Thread'} (${slot.model || slot.agent})`,
      agent: slot.agent,
      ...(slot.model ? { model: slot.model } : {}),
      ...(slot.effort ? { effort: slot.effort } : {}),
      status: 'working',
      deletedFromUi: false,
      updatedAt: now,
      summary: `Launched from ${folder.name} Multi-Model Fleet with ${slot.agent} (${slot.model ?? 'default'}, effort=${slot.effort ?? 'high'}${slot.team ? ', Team/Subagents ON' : ''}). Clean Output.txt transcript and per-thread memory persisted in .omni-project.`,
      memoryPath: `${workspaceRoot}/.omni-project/memory/threads/${threadId}.md`,
      outputTxtPath: `${workspaceRoot}/.omni-project/transcripts/${threadId}/Output.txt`
    }
    const nextMemories = [memoryEntry, ...(settings.threadMemories ?? [])].slice(0, 25)
    setProjectSettingsByPerson(
      folder.id,
      {
        ...settings,
        threadMemories: nextMemories,
        updatedAt: now
      },
      { via: 'work' }
    )
    launch.start(pick, {
      ...(slot.templateId ? { templateId: slot.templateId } : {}),
      onLaunched: (tabId) => {
        fileLaunchInFolder(tabId, folder.id)
      }
    })
  }

  const copyPath = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text)
    setCopiedKey(key)
    toast.success('Copied path to clipboard')
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev))
    }, 1800)
  }

  const memories = settings.threadMemories ?? []
  const deletedPreservedCount = memories.filter((m) => m.deletedFromUi).length

  return (
    <div className="space-y-4" data-session-project-multi-thread-launcher="">
      {/* Multi-Model Parallel Thread Fleet Card */}
      <section className="rounded-xl border bg-card/60 p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setFleetOpen((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            {fleetOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <Layers className="size-4 text-primary" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {translate(
                    'projects.multiThread.title',
                    'Multi-Model Parallel Thread Launcher (Claude Teams + Codex Subagents + Grok)'
                  )}
                </h3>
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  {fleet.length} models configured
                </span>
              </div>
              {settings.goal ? (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                  <span className="font-medium text-foreground/80">Goal:</span> {settings.goal}
                </p>
              ) : null}
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => applyPreset('triad')}
              title="Claude Opus 5.5 (xhigh Team) + GPT-6 Astra (xhigh Team) + Grok 4 (high)"
            >
              Triad Preset
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => applyPreset('dual-teams')}
              title="Claude Agent Teams + Codex Subagents"
            >
              <Users className="size-3" />
              Claude + Codex Teams
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => applyPreset('council')}
              title="Opus 5.5 + GPT-6 Astra + Grok 4 + Kimi K3 Max"
            >
              4-Model Council
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={launch.starting || fleet.length === 0}
              onClick={() => {
                fleet.forEach((slot, idx) => {
                  setTimeout(() => launchSingleSlot(slot, idx), idx * 180)
                })
              }}
              data-session-project-spawn-all-threads=""
            >
              <Sparkles className="size-3" />
              {translate('projects.multiThread.spawnAll', 'Spawn {{count}} Parallel Threads', {
                count: fleet.length
              })}
            </Button>
          </div>
        </div>

        {fleetOpen ? (
          <div className="mt-3 space-y-2 border-t pt-3">
            <div className="grid gap-2">
              {fleet.map((slot, index) => {
                const models = MODEL_PRESETS_BY_AGENT[slot.agent] ?? [slot.model ?? 'default']
                const offersTeam = coordinatorAgentOffersTeam(slot.agent)
                return (
                  <div
                    key={`${slot.agent}-${index}`}
                    className="flex flex-wrap items-center gap-2 rounded-lg border bg-background/80 px-3 py-2 text-xs"
                    data-session-project-fleet-slot={index}
                  >
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold">
                      {index + 1}
                    </span>
                    <input
                      type="text"
                      value={slot.role ?? ''}
                      placeholder="Thread role (e.g. Lead Verifier)"
                      onChange={(e) => {
                        const next = [...fleet]
                        next[index] = { ...slot, role: e.target.value }
                        updateFleet(next)
                      }}
                      className="min-w-[140px] flex-1 rounded border bg-transparent px-2 py-1 text-xs"
                    />
                    <select
                      aria-label="Thread provider"
                      value={slot.agent}
                      onChange={(e) => {
                        const nextAgent = e.target.value as TuiAgent
                        const defaultModel = MODEL_PRESETS_BY_AGENT[nextAgent]?.[0]
                        const next = [...fleet]
                        next[index] = {
                          ...slot,
                          agent: nextAgent,
                          ...(defaultModel ? { model: defaultModel } : {}),
                          team: coordinatorAgentOffersTeam(nextAgent)
                        }
                        updateFleet(next)
                      }}
                      className="rounded border bg-background px-2 py-1 text-xs font-medium"
                    >
                      {COORDINATOR_AGENTS.map((ag) => (
                        <option key={ag} value={ag}>
                          {ag.toUpperCase()}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Thread model"
                      value={slot.model ?? models[0] ?? ''}
                      onChange={(e) => {
                        const next = [...fleet]
                        next[index] = { ...slot, model: e.target.value }
                        updateFleet(next)
                      }}
                      className="rounded border bg-background px-2 py-1 font-mono text-xs"
                    >
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Thread effort"
                      value={slot.effort ?? 'high'}
                      onChange={(e) => {
                        const next = [...fleet]
                        next[index] = { ...slot, effort: e.target.value }
                        updateFleet(next)
                      }}
                      className="rounded border bg-background px-2 py-1 text-xs"
                    >
                      {EFFORT_OPTIONS.map((eff) => (
                        <option key={eff} value={eff}>
                          Effort: {eff}
                        </option>
                      ))}
                    </select>

                    {offersTeam ? (
                      <label className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={Boolean(slot.team)}
                          onChange={(e) => {
                            const next = [...fleet]
                            next[index] = { ...slot, team: e.target.checked }
                            updateFleet(next)
                          }}
                        />
                        <span>{slot.agent === 'claude' ? 'Claude Teams' : 'Codex Subagents'}</span>
                      </label>
                    ) : null}

                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={launch.starting}
                      onClick={() => launchSingleSlot(slot, index)}
                      title="Launch this thread in the project"
                    >
                      <Play className="size-3" />
                      Launch
                    </Button>

                    {fleet.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => updateFleet(fleet.filter((_, i) => i !== index))}
                        title="Remove slot"
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={fleet.length >= 8}
                onClick={() =>
                  updateFleet([
                    ...fleet,
                    {
                      agent: 'claude',
                      model: 'claude-opus-5-5',
                      effort: 'xhigh',
                      team: true,
                      role: `Worker Thread #${fleet.length + 1}`
                    }
                  ])
                }
              >
                <Plus className="size-3.5" />
                Add model thread slot
              </Button>
              <button
                type="button"
                onClick={() => openProjectSettings(folder.id)}
                className="text-xs text-primary hover:underline"
              >
                Configure Coordinator & Thread Defaults in Project Settings →
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Per-Thread Memories & Clean Output.txt Transcripts Section */}
      <section
        className="rounded-xl border bg-card/60 p-4 shadow-xs"
        data-session-project-thread-memories=""
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setMemoriesOpen((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            {memoriesOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <FileText className="size-4 text-emerald-500" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {translate(
                    'projects.memories.title',
                    'Per-Thread Memories & Clean Output.txt Transcripts (Argon / JEV Format)'
                  )}
                </h3>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  {memories.length} thread memories saved
                </span>
                {deletedPreservedCount > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    <ArchiveRestore className="size-3" />
                    {deletedPreservedCount} preserved after thread deletion
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every thread saves its own memory file (<code>.omni-project/memory/threads/</code>)
                and tool-call-free <code>Output.txt</code> transcript (survives thread deletion &
                transfers via MCP to Claude, Codex & Grok).
              </p>
            </div>
          </button>

          <Button size="xs" variant="outline" onClick={() => openProjectSettings(folder.id)}>
            Inspect in Project Settings
          </Button>
        </div>

        {memoriesOpen ? (
          <div className="mt-3 space-y-2 border-t pt-3">
            {memories.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                No per-thread memory records yet. Active threads ({threads.length}) automatically
                write their memory to <code>{workspaceRoot}/.omni-project/memory/threads/</code> and
                clean transcript to <code>Output.txt</code>.
              </p>
            ) : (
              <ul className="space-y-2">
                {memories.slice(0, 8).map((mem) => {
                  const memPath =
                    mem.memoryPath ??
                    `${workspaceRoot}/.omni-project/memory/threads/${mem.threadId}.md`
                  const outPath =
                    mem.outputTxtPath ??
                    `${workspaceRoot}/.omni-project/transcripts/${mem.threadId}/Output.txt`
                  return (
                    <li
                      key={mem.threadId}
                      className="rounded-lg border bg-background/80 p-2.5 text-xs"
                      data-session-project-memory-row={mem.threadId}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Bot className="size-3.5 text-primary" />
                          <span className="font-semibold">{mem.title}</span>
                          <span className="rounded border px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground">
                            {mem.agent}
                            {mem.model ? ` · ${mem.model}` : ''}
                            {mem.effort ? ` (${mem.effort})` : ''}
                          </span>
                          {mem.deletedFromUi ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              <ArchiveRestore className="size-2.5" />
                              Deleted thread · Memory preserved
                            </span>
                          ) : (
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                                mem.status === 'working'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {mem.status ?? 'saved'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => copyPath(`mem-${mem.threadId}`, memPath)}
                            className="inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            title={memPath}
                          >
                            {copiedKey === `mem-${mem.threadId}` ? (
                              <Check className="size-2.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-2.5" />
                            )}
                            memory/{mem.threadId.slice(0, 18)}.md
                          </button>
                          <button
                            type="button"
                            onClick={() => copyPath(`out-${mem.threadId}`, outPath)}
                            className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 font-mono text-[10px] text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"
                            title={outPath}
                          >
                            {copiedKey === `out-${mem.threadId}` ? (
                              <Check className="size-2.5" />
                            ) : (
                              <FileText className="size-2.5" />
                            )}
                            Output.txt (No Tool Calls)
                          </button>
                        </div>
                      </div>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{mem.summary}</p>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}
