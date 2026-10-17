import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { LocalRunCanvasDraft, LocalRunDraftNode } from '@/lib/local-run-draft'
import { SESSION_ACTION_PRESET_IDS } from '../../../../shared/session-action-presets'
import type { SessionActionPresetId } from '../../../../shared/session-action-presets'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentAccountSelect } from '../agent/AgentAccountSelect'
import { BuildReviewAgentFields } from '../build-review/BuildReviewAgentFields'
import { WorkflowSelect, WorkflowTextField } from '../console-workflows/WorkflowFields'
import { localRunPresetLabel } from './local-run-labels'

/**
 * One step of a draft: the actor (agent, model, effort, account), the action preset,
 * whether it asks a person first, where it runs, and what it waits for. The actor
 * fields are the same ones Build + Review and chained sessions use, so every surface
 * reads the same host probe and offers the same menus.
 */
export function LocalRunDraftNodeEditor({
  draft,
  node,
  onChange,
  onRemove,
  onConnect,
  onDisconnect
}: {
  draft: LocalRunCanvasDraft
  node: LocalRunDraftNode
  onChange: (next: LocalRunDraftNode) => void
  onRemove: () => void
  onConnect: (fromId: string) => void
  onDisconnect: (fromId: string) => void
}) {
  const others = draft.nodes.filter((entry) => entry.id !== node.id)
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border border-border p-3">
      <legend className="flex items-center gap-2 px-1 text-sm font-medium">{node.id}</legend>
      <BuildReviewAgentFields
        role={node.id}
        label={translate('auto.components.local-run.DraftNode.actor', 'Actor')}
        worktree={draft.workspaceSelector}
        choice={{
          agent: node.agent,
          ...(node.model ? { model: node.model } : {}),
          ...(node.effort ? { effort: node.effort } : {})
        }}
        onChange={(choice) =>
          onChange({
            ...node,
            agent: choice.agent as TuiAgent,
            model: choice.model ?? '',
            effort: choice.effort ?? ''
          })
        }
        helpText={translate(
          'auto.components.local-run.DraftNode.actorHelp',
          'Agent chooses the tool this step runs; Model and Effort belong to that tool; Account chooses which sign-in it starts under.'
        )}
      />
      <AgentAccountSelect
        id={`local-run-account-${node.id}`}
        agent={node.agent}
        value={node.accountChoiceId}
        onChange={(accountChoiceId) => onChange({ ...node, accountChoiceId })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowSelect
          label={translate('auto.components.local-run.DraftNode.preset', 'Action')}
          value={node.presetId}
          onChange={(presetId) =>
            onChange({ ...node, presetId: presetId as SessionActionPresetId })
          }
          options={SESSION_ACTION_PRESET_IDS.map((presetId) => ({
            value: presetId,
            label: localRunPresetLabel(presetId)
          }))}
        />
        <WorkflowSelect
          label={translate('auto.components.local-run.DraftNode.placement', 'Runs on')}
          value={node.placement}
          onChange={(placement) =>
            onChange({ ...node, placement: placement === 'fleet' ? 'fleet' : 'local' })
          }
          options={[
            {
              value: 'local',
              label: translate('auto.components.local-run.DraftNode.local', 'This computer')
            },
            {
              value: 'fleet',
              label: translate(
                'auto.components.local-run.DraftNode.fleet',
                'Fleet (admit through the console)'
              )
            }
          ]}
        />
      </div>
      <WorkflowTextField
        label={translate('auto.components.local-run.DraftNode.objective', 'Objective')}
        value={node.objective}
        onChange={(objective) => onChange({ ...node, objective })}
        multiline
      />
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`local-run-gate-${node.id}`}
            checked={node.gate}
            onCheckedChange={(checked) => onChange({ ...node, gate: checked === true })}
          />
          <Label htmlFor={`local-run-gate-${node.id}`}>
            {translate('auto.components.local-run.DraftNode.gate', 'Ask me before this step runs')}
          </Label>
        </div>
        {node.gate && (
          <WorkflowTextField
            label={translate('auto.components.local-run.DraftNode.gateQuestion', 'Question')}
            value={node.gateQuestion}
            onChange={(gateQuestion) => onChange({ ...node, gateQuestion })}
          />
        )}
      </div>
      {others.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.local-run.DraftNode.after', 'Runs after')}
          </p>
          <div className="flex flex-wrap gap-3">
            {others.map((other) => {
              const connected = node.deps.includes(other.id)
              return (
                <div key={other.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`local-run-dep-${node.id}-${other.id}`}
                    checked={connected}
                    onCheckedChange={(checked) =>
                      checked === true ? onConnect(other.id) : onDisconnect(other.id)
                    }
                  />
                  <Label htmlFor={`local-run-dep-${node.id}-${other.id}`}>{other.id}</Label>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={onRemove}>
        <Trash2 />
        {translate('auto.components.local-run.DraftNode.remove', 'Remove step')}
      </Button>
    </fieldset>
  )
}
