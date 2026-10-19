/* eslint-disable max-lines */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Plus } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  MAX_CUSTOM_AGENT_TEMPLATES,
  agentTemplateIdFromName,
  findAgentTemplate,
  normalizeAgentTemplateSettings,
  resolveAgentTemplates,
  type AgentTemplate,
  type AgentTemplateOverride,
  type AgentTemplateSettings,
  type PreferredAgent
} from '../../../../shared/agent-templates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Props = {
  settings: GlobalSettings
  /** Opens the pane on this template; the caller remounts (keys) the editor per request. */
  initialTemplateId?: string
}

type Draft = {
  name: string
  description: string
  instructions: string
  preferredModel: string
  preferredAgent: string
  defaultSkills: string
  callableSkills: string
  memory: string
}

function parseCommaList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function draftFor(template: AgentTemplate): Draft {
  const defaultSkills =
    template.defaultSkills ?? (template.skills ? template.skills.slice(0, 1) : [])
  const callableSkills =
    template.callableSkills ??
    (template.skills ? template.skills.filter((s) => !defaultSkills.includes(s)) : [])
  return {
    name: template.name,
    description: template.description,
    instructions: template.instructions ?? '',
    preferredModel: template.preferredModel ?? '',
    preferredAgent: template.preferredAgent ?? '',
    defaultSkills: defaultSkills.join(', '),
    callableSkills: callableSkills.join(', '),
    memory: template.memory ?? ''
  }
}

/**
 * Reusable instructions a launcher can add on top of the workspace's own files.
 * Built-ins are edited as overrides (Reset restores the shipped text); custom
 * templates are the user's own. `Default` is the explicit "add nothing" choice.
 */
export function AgentTemplatesSetting({ settings, initialTemplateId }: Props): React.JSX.Element {
  const stored = useMemo(
    () => normalizeAgentTemplateSettings(settings.agentTemplates),
    [settings.agentTemplates]
  )
  const templates = useMemo(() => resolveAgentTemplates(stored), [stored])
  const [selectedId, setSelectedId] = useState(initialTemplateId ?? 'developer')
  const persistQueue = useRef<Promise<void>>(Promise.resolve())
  // Why: late completions must act on the selection at completion time, not at click time.
  const selectedRef = useRef(selectedId)
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])
  const selected = findAgentTemplate(templates, selectedId)
  const [draft, setDraft] = useState<Draft | null>(null)
  const shown = draft ?? draftFor(selected)
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftFor(selected))
  const isDefault = selected.id === AGENT_TEMPLATE_DEFAULT_ID
  const customCount = stored.custom?.length ?? 0

  const select = (id: string): void => {
    setSelectedId(id)
    setDraft(null)
  }
  // Why: the plain `updateSettings` swallows write errors, so a failed save must keep the draft.
  // Writes are serialized. On the desktop each composes from main's CURRENT settings, never the
  // renderer store, because an unrelated write in flight can leave the store without the previous
  // save. The paired web client composes from the store: its `settings.get` writes a pre-await
  // snapshot back to local storage, and its writes land in local storage synchronously anyway.
  const persist = (
    update: (current: AgentTemplateSettings) => AgentTemplateSettings
  ): Promise<void> =>
    (persistQueue.current = persistQueue.current
      .catch(() => undefined)
      .then(async () => {
        const current = isPairedWebClientWindow()
          ? useAppStore.getState().settings
          : ((await window.api.settings.get()) as Partial<GlobalSettings> | undefined)
        await useAppStore.getState().updateSettingsOrThrow({
          agentTemplates: normalizeAgentTemplateSettings(
            update(normalizeAgentTemplateSettings(current?.agentTemplates))
          )
        })
      }))
      .then(() => undefined)
      .catch((error: unknown) => {
        toast.error(
          translate(
            'components.settings.agentTemplates.saveFailed',
            'Could not save the template.'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
        throw error
      })
  const save = (): void => {
    if (!draft) {
      return
    }
    const savedDraft = draft
    // Why: only the draft that was written is cleared; text typed meanwhile stays unsaved.
    const clear = (): void => setDraft((current) => (current === savedDraft ? null : current))
    const preferredModel = draft.preferredModel.trim() || undefined
    const rawAgent = draft.preferredAgent.trim().toLowerCase()
    const preferredAgent: PreferredAgent | undefined =
      rawAgent === 'claude' || rawAgent === 'codex' || rawAgent === 'grok' || rawAgent === 'gemini'
        ? rawAgent
        : undefined
    const defaultSkills = parseCommaList(draft.defaultSkills)
    const callableSkills = parseCommaList(draft.callableSkills)
    const skills = Array.from(new Set([...defaultSkills, ...callableSkills]))
    const memory = draft.memory.trim() || undefined
    const extraFields: Pick<
      AgentTemplateOverride,
      'preferredModel' | 'preferredAgent' | 'skills' | 'defaultSkills' | 'callableSkills' | 'memory'
    > = {
      ...(preferredModel ? { preferredModel } : {}),
      ...(preferredAgent ? { preferredAgent } : {}),
      ...(skills.length ? { skills } : {}),
      ...(defaultSkills.length ? { defaultSkills } : {}),
      ...(callableSkills.length ? { callableSkills } : {}),
      ...(memory ? { memory } : {})
    }
    if (selected.builtin) {
      void persist((current) => ({
        ...current,
        overrides: {
          ...current.overrides,
          [selected.id]: {
            description: draft.description.trim(),
            ...(isDefault ? {} : { instructions: draft.instructions }),
            ...extraFields
          }
        }
      })).then(clear, () => undefined)
    } else {
      void persist((current) => ({
        ...current,
        custom: (current.custom ?? []).map((entry) =>
          entry.id === selected.id
            ? {
                id: entry.id,
                name: draft.name.trim() || entry.name,
                description: draft.description.trim(),
                instructions: draft.instructions,
                ...extraFields
              }
            : entry
        )
      })).then(clear, () => undefined)
    }
  }
  const reset = (): void => {
    const resetId = selected.id
    void persist((current) => {
      const { [resetId]: _dropped, ...rest } = current.overrides ?? {}
      return { ...current, overrides: rest }
    }).then(
      () => {
        if (selectedRef.current === resetId) {
          setDraft(null)
        }
      },
      () => undefined
    )
  }
  const remove = (): void => {
    const removedId = selected.id
    void persist((current) => ({
      ...current,
      custom: (current.custom ?? []).filter((entry) => entry.id !== removedId)
    })).then(
      () => {
        if (selectedRef.current === removedId) {
          select(AGENT_TEMPLATE_DEFAULT_ID)
        }
      },
      () => undefined
    )
  }
  const create = (): void => {
    const name = translate('components.settings.agentTemplates.newName', 'New template')
    let id = ''
    // Why: the id is chosen against the store at write time, so two quick creates never collide.
    void persist((current) => {
      // Why: the disabled button reads a stale count; normalizing would silently drop this entry.
      if ((current.custom?.length ?? 0) >= MAX_CUSTOM_AGENT_TEMPLATES) {
        throw new Error(
          translate(
            'components.settings.agentTemplates.limitReached',
            'You already have {{max}} custom templates. Delete one to add another.',
            { max: MAX_CUSTOM_AGENT_TEMPLATES }
          )
        )
      }
      const taken = new Set(resolveAgentTemplates(current).map((template) => template.id))
      id = agentTemplateIdFromName(name)
      for (let n = 2; taken.has(id); n += 1) {
        id = `${agentTemplateIdFromName(name)}-${n}`
      }
      return {
        ...current,
        custom: [
          ...(current.custom ?? []),
          { id, name, description: '', instructions: `# ${name}\n` }
        ]
      }
    }).then(
      // Why: select once the list can show it; selecting first flashes Default.
      () => select(id),
      () => undefined
    )
  }

  return (
    <section id="agent-templates" data-settings-section="agent-templates" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('components.settings.agentTemplates.title', 'Agent templates')}
        description={translate(
          'components.settings.agentTemplates.description',
          'Reusable instructions the launcher adds after the workspace’s own AGENTS.md and the global rules. Default adds nothing. Built-in templates can be edited; Reset restores the shipped text.'
        )}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={customCount >= MAX_CUSTOM_AGENT_TEMPLATES}
            onClick={create}
          >
            <Plus />
            {translate('components.settings.agentTemplates.new', 'New template')}
          </Button>
        }
      />
      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <div
          role="listbox"
          aria-label={translate('components.settings.agentTemplates.list', 'Templates')}
          className="flex flex-col gap-0.5 self-start rounded-lg border border-border p-1"
        >
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              role="option"
              aria-selected={template.id === selected.id}
              data-current={template.id === selected.id ? 'true' : undefined}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent',
                template.id === selected.id && 'bg-accent'
              )}
              onClick={() => select(template.id)}
            >
              <Bot className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{template.name}</span>
              {!template.builtin ? (
                <Badge variant="secondary">
                  {translate('components.settings.agentTemplates.custom', 'custom')}
                </Badge>
              ) : template.edited ? (
                <Badge variant="secondary">
                  {translate('components.settings.agentTemplates.edited', 'edited')}
                </Badge>
              ) : null}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-name">
                {translate('components.settings.agentTemplates.name', 'Name')}
              </Label>
              <Input
                id="agent-template-name"
                value={shown.name}
                disabled={selected.builtin}
                onChange={(event) => setDraft({ ...shown, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-model">
                {translate('components.settings.agentTemplates.preferredModel', 'Preferred model')}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {translate('components.settings.agentTemplates.optional', 'optional')}
                </span>
              </Label>
              <Input
                id="agent-template-model"
                disabled={isDefault}
                placeholder={translate(
                  'components.settings.agentTemplates.preferredModelPlaceholder',
                  'ollama/qwen3-coder:30b'
                )}
                value={shown.preferredModel}
                onChange={(event) => setDraft({ ...shown, preferredModel: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-template-description">
              {translate('components.settings.agentTemplates.descriptionField', 'Description')}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                {translate(
                  'components.settings.agentTemplates.shownInPicker',
                  'shown in the picker'
                )}
              </span>
            </Label>
            <Input
              id="agent-template-description"
              disabled={isDefault}
              value={shown.description}
              onChange={(event) => setDraft({ ...shown, description: event.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-agent">
                {translate('components.settings.agentTemplates.preferredAgent', 'Preferred agent')}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  claude / codex / grok / gemini
                </span>
              </Label>
              <Input
                id="agent-template-agent"
                disabled={isDefault}
                placeholder="claude"
                value={shown.preferredAgent}
                onChange={(event) => setDraft({ ...shown, preferredAgent: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-memory">
                {translate('components.settings.agentTemplates.memory', 'Memory file')}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {translate('components.settings.agentTemplates.optional', 'optional')}
                </span>
              </Label>
              <Input
                id="agent-template-memory"
                disabled={isDefault}
                placeholder="~/Work/Shared/Reverse-Engineering/memory/LESSONS.md"
                value={shown.memory}
                onChange={(event) => setDraft({ ...shown, memory: event.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-default-skills">
                {translate(
                  'components.settings.agentTemplates.defaultSkills',
                  'Default-loaded skills (Tier 1)'
                )}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  auto-injected at startup
                </span>
              </Label>
              <Input
                id="agent-template-default-skills"
                disabled={isDefault}
                placeholder="reverse-engineer"
                value={shown.defaultSkills}
                onChange={(event) => setDraft({ ...shown, defaultSkills: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-template-callable-skills">
                {translate(
                  'components.settings.agentTemplates.callableSkills',
                  'Callable skills (Tier 2)'
                )}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  on-demand by trigger
                </span>
              </Label>
              <Input
                id="agent-template-callable-skills"
                disabled={isDefault}
                placeholder="omni-boundary-review, omni-reuse-research"
                value={shown.callableSkills}
                onChange={(event) => setDraft({ ...shown, callableSkills: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-template-instructions">
              {translate('components.settings.agentTemplates.instructions', 'Instructions')}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                {isDefault
                  ? translate(
                      'components.settings.agentTemplates.defaultAddsNothing',
                      'Default adds nothing'
                    )
                  : selected.builtin && !selected.edited && draft === null
                    ? translate('components.settings.sessionActionPresets.builtIn', 'built-in')
                    : selected.builtin
                      ? translate('components.settings.agentTemplates.override', 'your override')
                      : ''}
              </span>
            </Label>
            <Textarea
              id="agent-template-instructions"
              rows={10}
              className="font-mono text-xs"
              disabled={isDefault}
              value={shown.instructions}
              onChange={(event) => setDraft({ ...shown, instructions: event.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!dirty} onClick={save}>
              {translate('components.settings.sessionActionPresets.save', 'Save template')}
            </Button>
            {selected.builtin ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!selected.edited && draft === null}
                onClick={reset}
              >
                {translate('components.settings.sessionActionPresets.reset', 'Reset to built-in')}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={remove}
              >
                {translate('components.settings.agentTemplates.delete', 'Delete')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
