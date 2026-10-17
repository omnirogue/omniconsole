import { useState } from 'react'
import { Play, Plus, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { localRunStartRefusal } from '@/lib/local-run-admission'
import {
  addLocalRunDraftNode,
  connectLocalRunDraftNodes,
  disconnectLocalRunDraftNodes,
  localRunDraftFromTemplate,
  localRunDraftGraph,
  localRunDraftSaveParams,
  localRunDraftView,
  removeLocalRunDraftNode,
  type LocalRunCanvasDraft
} from '@/lib/local-run-draft'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  LOCAL_RUN_TEMPLATE_COUNTED,
  LOCAL_RUN_TEMPLATE_IDS,
  type LocalRunTemplateId
} from '../../../../shared/local-run-templates'
import { LOCAL_RUN_RPC, type LocalRunSnapshot } from '../../../../shared/local-run-types'
import { WorkflowSelect, WorkflowTextField } from '../console-workflows/WorkflowFields'
import { LocalRunCanvas } from './LocalRunCanvas'
import { LocalRunDraftAdmission } from './LocalRunDraftAdmission'
import { LocalRunDraftNodeEditor } from './LocalRunDraftNodeEditor'
import type { LocalRunWorkspaceOption } from './local-run-workspaces'

const CYCLE_MESSAGE_KEY = 'auto.components.local-run.Draft.cycle'

/**
 * Draft mode: author a graph, then either run it here or admit it through the console.
 * The workspace is a folder first — every graph on this canvas can run on a folder of
 * material with no repository — and the same canvas draws the draft and the run.
 */
export function LocalRunDraftEditor({
  draft,
  workspaces,
  onChange,
  onSave,
  onStarted,
  onAdmit
}: {
  draft: LocalRunCanvasDraft
  workspaces: readonly LocalRunWorkspaceOption[]
  onChange: (next: LocalRunCanvasDraft) => void
  onSave?: (params: ReturnType<typeof localRunDraftSaveParams>) => Promise<void>
  onStarted: (run: LocalRunSnapshot) => void
  onAdmit: (composer: WorkflowDraft) => void
}) {
  const [templateId, setTemplateId] = useState<LocalRunTemplateId>(LOCAL_RUN_TEMPLATE_IDS[0])
  const [templateCount, setTemplateCount] = useState('3')
  const [objective, setObjective] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const refusal = localRunStartRefusal(draft)
  const applyTemplate = () => {
    onChange(
      localRunDraftFromTemplate(templateId, draft, {
        objective: objective.trim() || draft.title.trim(),
        agent: draft.nodes[0]?.agent ?? 'codex',
        ...(LOCAL_RUN_TEMPLATE_COUNTED.includes(templateId)
          ? { count: Number.parseInt(templateCount, 10) }
          : {})
      })
    )
    setError(null)
  }
  const runLocally = async (): Promise<void> => {
    if (refusal) {
      setError(refusal.message)
      return
    }
    setPending(true)
    setError(null)
    try {
      const { run } = await callRuntimeRpc<{ run: LocalRunSnapshot }>(
        { kind: 'local' },
        LOCAL_RUN_RPC.create,
        { graph: localRunDraftGraph(draft) }
      )
      const { run: started } = await callRuntimeRpc<{ run: LocalRunSnapshot }>(
        { kind: 'local' },
        LOCAL_RUN_RPC.start,
        { id: run.id }
      )
      onStarted(started)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(false)
    }
  }
  const save = async (): Promise<void> => {
    if (!onSave) {
      return
    }
    setPending(true)
    try {
      await onSave(localRunDraftSaveParams(draft))
      setError(null)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="min-w-0 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowTextField
          label={translate('auto.components.local-run.Draft.title', 'Graph name')}
          value={draft.title}
          onChange={(title) => onChange({ ...draft, title })}
        />
        <WorkflowSelect
          label={translate('auto.components.local-run.Draft.workspace', 'Workspace')}
          value={draft.workspaceSelector}
          onChange={(value) => {
            const workspace = workspaces.find((entry) => entry.value === value)
            if (workspace) {
              onChange({
                ...draft,
                workspacePath: workspace.path,
                workspaceSelector: workspace.value,
                workspaceKind: workspace.kind
              })
            }
          }}
          options={workspaces.map((workspace) => ({
            value: workspace.value,
            label: `${workspace.label} · ${workspace.path}`
          }))}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {translate('auto.components.local-run.Draft.folderFirst', 'Runs in this folder')}:{' '}
        {draft.workspacePath}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <WorkflowSelect
          label={translate('auto.components.local-run.Draft.template', 'Start from a template')}
          value={templateId}
          onChange={(value) => setTemplateId(value as LocalRunTemplateId)}
          options={LOCAL_RUN_TEMPLATE_IDS.map((id) => ({ value: id, label: templateLabel(id) }))}
        />
        {LOCAL_RUN_TEMPLATE_COUNTED.includes(templateId) && (
          <WorkflowTextField
            label={translate('auto.components.local-run.Draft.count', 'How many')}
            value={templateCount}
            onChange={setTemplateCount}
          />
        )}
        <WorkflowTextField
          label={translate('auto.components.local-run.Draft.objective', 'What to do')}
          value={objective}
          onChange={setObjective}
        />
      </div>
      <Button size="sm" variant="outline" disabled={pending} onClick={applyTemplate}>
        {translate('auto.components.local-run.Draft.useTemplate', 'Use this template')}
      </Button>
      <LocalRunCanvas
        view={localRunDraftView(draft)}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <div className="space-y-3">
        {draft.nodes.map((node) => (
          <LocalRunDraftNodeEditor
            key={node.id}
            draft={draft}
            node={node}
            onChange={(next) =>
              onChange({
                ...draft,
                nodes: draft.nodes.map((entry) => (entry.id === node.id ? next : entry))
              })
            }
            onRemove={() => onChange(removeLocalRunDraftNode(draft, node.id))}
            onConnect={(fromId) => {
              const edit = connectLocalRunDraftNodes(
                draft,
                fromId,
                node.id,
                translate(
                  CYCLE_MESSAGE_KEY,
                  'Steps cannot depend on each other in a circle. Remove one of the two links first.'
                )
              )
              onChange(edit.draft)
              setError(edit.error)
            }}
            onDisconnect={(fromId) =>
              onChange(disconnectLocalRunDraftNodes(draft, fromId, node.id))
            }
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onChange(addLocalRunDraftNode(draft))}>
          <Plus />
          {translate('auto.components.local-run.Draft.addNode', 'Add step')}
        </Button>
        {onSave && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void save()}>
            <Save />
            {translate('auto.components.local-run.Draft.save', 'Save graph')}
          </Button>
        )}
        <Button size="sm" disabled={pending || !!refusal} onClick={() => void runLocally()}>
          <Play />
          {translate('auto.components.local-run.Draft.run', 'Run locally')}
        </Button>
      </div>
      {refusal && (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {refusal.message}
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
          {error}
        </p>
      )}
      <LocalRunDraftAdmission draft={draft} onAdmit={onAdmit} />
    </section>
  )
}

function templateLabel(id: LocalRunTemplateId): string {
  const labels: Record<LocalRunTemplateId, string> = {
    'research-plan-produce-review-verify': translate(
      'auto.components.local-run.Template.researchProduceVerify',
      'Research → Plan → Produce → Review → Verify'
    ),
    'fan-out-synthesize': translate(
      'auto.components.local-run.Template.fanOutSynthesize',
      'Fan-out → Synthesize'
    ),
    'improve-steps': translate('auto.components.local-run.Template.improveSteps', 'Improve × N')
  }
  return labels[id]
}
