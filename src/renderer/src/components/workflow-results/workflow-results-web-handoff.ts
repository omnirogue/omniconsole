import { sha256 } from '@/lib/sha256'
import type { WorkflowWebCheck } from '../../../../shared/workflow-graph-web'
import {
  workflowWebCheckLines,
  workflowWebChecksBlock,
  workflowWebFence
} from '../../../../shared/workflow-web-fence'

// The first 12 hex of the text's own hash, as the main process names its fences.
const nonce = (text: string) =>
  Array.from(sha256(new TextEncoder().encode(text)).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')

/** A result from a run that reads pages: app facts outside, every model word in one fence. */
export function workflowResultsWebBlock(input: {
  heading: string
  standing: string
  written: string
  checks: readonly WorkflowWebCheck[]
}): string {
  const block = workflowWebChecksBlock(workflowWebCheckLines(input.checks))
  return [
    input.heading,
    input.standing,
    workflowWebFence(input.written, nonce(input.written), block)
  ]
    .filter(Boolean)
    .join('\n')
}
