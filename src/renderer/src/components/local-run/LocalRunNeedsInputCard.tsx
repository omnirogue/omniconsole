import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL_RUN_RPC, type LocalRunSnapshot } from '../../../../shared/local-run-types'
import { localRunNodeStateLabel } from './local-run-labels'

/**
 * The one thing a person must be able to do while a local run is going: answer the
 * node that is waiting on them. A gated node is answered through the orchestration
 * gate; a node whose worker asked something is answered by replying to that worker.
 */
export function LocalRunNeedsInputCard({
  run,
  onAnswered
}: {
  run: LocalRunSnapshot
  onAnswered?: (next: LocalRunSnapshot) => void
}) {
  const waiting = run.nodes.filter((node) => node.state === 'needs-input')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (waiting.length === 0) {
    return null
  }
  const answer = async (nodeId: string): Promise<void> => {
    const node = waiting.find((entry) => entry.id === nodeId)
    const resolution = (answers[nodeId] ?? '').trim()
    if (!node || !resolution) {
      return
    }
    setPendingNodeId(nodeId)
    setError(null)
    try {
      const { run: next } = await callRuntimeRpc<{ run: LocalRunSnapshot }>(
        { kind: 'local' },
        node.question ? LOCAL_RUN_RPC.reply : LOCAL_RUN_RPC.resolveGate,
        node.question
          ? { id: run.id, messageId: node.question.messageId, body: resolution }
          : { id: run.id, gateId: node.gateId, resolution }
      )
      setAnswers((current) => ({ ...current, [nodeId]: '' }))
      onAnswered?.(next)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPendingNodeId(null)
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">
        {translate('auto.components.local-run.NeedsInput.title', 'Waiting for you')}
      </h3>
      {waiting.map((node) => (
        <form
          key={node.id}
          className="space-y-2 rounded-md border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void answer(node.id)
          }}
        >
          <p className="text-xs text-muted-foreground">
            {node.id} · {localRunNodeStateLabel(node.state)}
          </p>
          <p className="whitespace-pre-wrap text-sm">
            {node.question?.question ??
              node.gateQuestion ??
              translate(
                'auto.components.local-run.NeedsInput.fallback',
                'This step needs an answer.'
              )}
          </p>
          {(node.question?.options ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {[...new Set(node.question?.options ?? [])].map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pendingNodeId === node.id}
                  onClick={() => setAnswers((current) => ({ ...current, [node.id]: option }))}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Label htmlFor={`local-run-answer-${node.id}`}>
            {translate('auto.components.local-run.NeedsInput.answer', 'Answer')}
          </Label>
          <Textarea
            id={`local-run-answer-${node.id}`}
            value={answers[node.id] ?? ''}
            disabled={pendingNodeId === node.id}
            onChange={(event) =>
              setAnswers((current) => ({ ...current, [node.id]: event.target.value }))
            }
          />
          <Button
            type="submit"
            size="sm"
            disabled={pendingNodeId === node.id || !(answers[node.id] ?? '').trim()}
          >
            {translate('auto.components.local-run.NeedsInput.send', 'Send answer')}
          </Button>
        </form>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
