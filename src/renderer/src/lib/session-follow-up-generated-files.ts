import { capturePickedHandoffFile } from '@/components/handoffs/handoff-client'
import { readSessionWorkOutput } from '@/lib/session-work-output'
import { FollowUpException, errorText } from '@/lib/session-follow-up-delivery'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'
import {
  buildFinalSummaryMarkdown,
  finalSummaryFileName
} from '../../../shared/session-follow-up-deliverables'

export function summaryFile(name: string, markdown: string): Promise<ExactHandoffFile> {
  return capturePickedHandoffFile(new File([markdown], name, { type: 'text/markdown' }))
}

export async function captureSummary(
  chain: SessionChain,
  rule: SessionFollowUpRule,
  paneKey: string,
  handle: string,
  signal: AbortSignal
): Promise<{ markdown: string; file: ExactHandoffFile }> {
  let output = ''
  try {
    output = await readSessionWorkOutput(chain, paneKey, handle, signal)
  } catch (error) {
    throw new FollowUpException('summary-unavailable', rule.sessionLabel, errorText(error))
  }
  if (!output.trim()) {
    throw new FollowUpException('summary-unavailable', rule.sessionLabel)
  }
  const markdown = buildFinalSummaryMarkdown({
    title: rule.taskTitle,
    sessionLabel: rule.sessionLabel,
    finishedAt: new Date().toISOString(),
    workspacePath: chain.workspacePath,
    output
  })
  return { markdown, file: await summaryFile(finalSummaryFileName(rule.sessionLabel), markdown) }
}
