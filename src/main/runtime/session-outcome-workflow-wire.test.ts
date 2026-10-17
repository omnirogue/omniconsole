import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sessionOutcomeWorkflowPreview } from '../../shared/session-outcome-workflow'

it.each(['initial', 'review-source'])(
  'retains actual BFF %s preview fields and canonical loop contracts',
  (name) => {
    const wire = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', `bff-outcome-${name}.json`), 'utf8')
    )
    const parsed = sessionOutcomeWorkflowPreview.parse(wire)
    expect(parsed.graph.nodes.map((node) => node.loop_stage)).toEqual(
      wire.graph.nodes.map((node: Record<string, unknown>) => node.loop_stage)
    )
    expect(
      parsed.graph.nodes
        .filter((node) => node.loop_stage?.role === 'participant')
        .map((node) => node.model)
    ).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-sol'])
    expect(
      parsed.graph.nodes
        .filter((node) => node.loop_stage?.role === 'repair')
        .map((node) => node.model)
    ).toEqual(['gpt-5.6-terra'])
    if (name === 'review-source') {
      expect(parsed.graph.nodes.some((node) => node.action === 'execute')).toBe(false)
      expect(parsed.graph.nodes[0]!.external_predecessor).toEqual(
        wire.graph.nodes[0].external_predecessor
      )
    } else {
      expect(parsed.graph.nodes[0]!.action).toBe('execute')
    }
  }
)

it.each(['base', 'review-source'])(
  'retains actual BFF current-folder %s source file authorization',
  (mode) => {
    const wire = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', 'bff-outcome-current-source.json'), 'utf8')
    )[mode]
    const parsed = sessionOutcomeWorkflowPreview.parse(wire)
    expect(parsed.graph.nodes.map((node) => node.current_source)).toEqual(
      wire.graph.nodes.map((node: Record<string, unknown>) => node.current_source)
    )
    expect(
      parsed.graph.nodes.every(
        (node) => node.current_source!.root_task_id === parsed.admission.filing_root_task_id
      )
    ).toBe(true)
  }
)
