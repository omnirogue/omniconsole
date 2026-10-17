import { useRef, useState } from 'react'
import { dispatchWorkspace, type WorkDispatchProject } from './work-dispatch-workspace'
import { WorkObjectiveComposer } from './WorkObjectiveComposer'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { launchProjectIn } from '@/lib/project-launch'
import { projectAgentForLaunch } from '../../../../shared/project-launch-inheritance'
import { projectAgentTemplateId } from '../../../../shared/project-agent-selection'
import { useSessionFolders } from '@/store/session-folders'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  SESSION_PREP_MAX_REQUEST_CHARS,
  SESSION_PREP_RPC
} from '../../../../shared/session-prep-types'
import { AGENT_TEMPLATE_DEFAULT_ID } from '../../../../shared/agent-templates'
import { AgentTemplateSelect } from '../agent/AgentTemplateSelect'
import { SessionPrepStatus } from '../native-chat/SessionPrepStatus'
import { noteSessionPrepBatch } from '../native-chat/session-prep-composer-state'
import {
  rememberedTemplate,
  rememberedTemplateId,
  rememberTemplate
} from '../sidebar/session-folders/new-conversation/launch-context'

export type { WorkDispatchProject } from './work-dispatch-workspace'

export function WorkDispatchComposer({
  project,
  independentObjectives = false,
  sourceWorktreeId
}: {
  /** Given on a project's page: the prepared threads are filed in it and inherit it. */
  project?: WorkDispatchProject
  independentObjectives?: boolean
  sourceWorktreeId?: string
} = {}): React.JSX.Element {
  const profileId = useAppStore((state) => state.activeOrcaProfileId)
  const paneKey = project
    ? `project-dispatch:${project.folderId}`
    : `work-dispatch:${profileId ?? 'default'}`
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why undefined until picked: the Work root's remembered template stays the live default.
  const [pickedTemplate, setPickedTemplate] = useState<string | null | undefined>(undefined)
  const settings = useAppStore((state) => state.settings)
  const remembered = project
    ? rememberedTemplateId(settings, null)
    : rememberedTemplate(settings, null).id
  const selectedTemplateId =
    pickedTemplate !== undefined
      ? pickedTemplate
      : remembered === AGENT_TEMPLATE_DEFAULT_ID
        ? null
        : remembered
  const projectAgents = useSessionFolders((state) =>
    project ? launchProjectIn(state.metadata, project.folderId)?.settings.agents : undefined
  )
  const agentTemplateId = projectAgents
    ? projectAgentTemplateId(projectAgents, settings?.agentTemplates, selectedTemplateId)
    : selectedTemplateId
  // Why resolve Default too: inside a project it means that project's first agent.
  const shownTemplateId =
    projectAgentForLaunch(projectAgents ?? [], agentTemplateId)?.templateId ?? agentTemplateId
  const pending = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)

  const dispatch = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || pending.current) {
      return
    }
    pending.current = true
    setSending(true)
    setError(null)
    try {
      const prepared = await dispatchWorkspace(project)
      if (!prepared.ok) {
        throw new Error(prepared.message)
      }
      // A profile switch during workspace discovery must not dispatch into the new account.
      if (useAppStore.getState().activeOrcaProfileId !== profileId) {
        return
      }
      await callRuntimeRpc({ kind: 'local' }, SESSION_PREP_RPC.request, {
        text,
        source: { worktreeId: prepared.id, paneKey, agent: 'codex', entryPoint: 'work' },
        context: '',
        // Why omitted for Default: the default request stays byte-identical for older hosts.
        ...(agentTemplateId && agentTemplateId !== AGENT_TEMPLATE_DEFAULT_ID
          ? { agentTemplateId }
          : {}),
        ...(project ? { defaultFolder: project.folderId } : {})
      })
      noteSessionPrepBatch(paneKey)
      setDraft('')
    } catch (cause) {
      setError(
        translate('sessionPrep.requestFailed', 'Could not start preparing sessions: {{reason}}', {
          reason: cause instanceof Error ? cause.message : String(cause)
        })
      )
    } finally {
      pending.current = false
      setSending(false)
      textarea.current?.focus()
    }
  }

  const templateSelect = (
    <AgentTemplateSelect
      id={`${paneKey}-agent-template`}
      value={shownTemplateId}
      {...(projectAgents ? { projectAgents } : {})}
      onChange={(next) => {
        setPickedTemplate(next)
        rememberTemplate(null, next ?? AGENT_TEMPLATE_DEFAULT_ID)
      }}
      disabled={sending}
    />
  )
  if (independentObjectives) {
    return (
      <WorkObjectiveComposer
        project={project}
        agentTemplateId={agentTemplateId}
        sourceWorktreeId={sourceWorktreeId}
      >
        {templateSelect}
      </WorkObjectiveComposer>
    )
  }

  const label = translate('work.dispatch.send', 'Dispatch')
  const prompt = project
    ? translate('projects.page.dispatchPrompt', 'Describe the work; threads start in {{name}}.', {
        name: project.name
      })
    : translate('work.dispatch.prompt', 'What would you like me to do today?')
  return (
    <section
      aria-label={label}
      className="space-y-2"
      data-testid={project ? 'session-project-dispatch' : 'work-dispatch'}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void dispatch()
        }}
        aria-busy={sending}
        className="flex items-end gap-2 rounded-xl border border-input bg-card p-3 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
      >
        <Textarea
          ref={textarea}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void dispatch()
            }
          }}
          readOnly={sending}
          maxLength={SESSION_PREP_MAX_REQUEST_CHARS}
          aria-label={prompt}
          placeholder={prompt}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${paneKey}-error` : undefined}
          className="max-h-48 min-h-16 flex-1 resize-none border-0 bg-transparent p-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon"
              className="shrink-0 rounded-full"
              disabled={sending || !draft.trim()}
              aria-label={label}
            >
              {sending ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </form>
      <div className="max-w-xs">{templateSelect}</div>
      {error ? (
        <p id={`${paneKey}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div aria-live="polite">
        <SessionPrepStatus paneKey={paneKey} draft={draft} setDraft={setDraft} />
      </div>
    </section>
  )
}
