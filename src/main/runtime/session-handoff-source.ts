import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import type { SessionFollowUpTranscriptSource } from '../../shared/session-follow-up-transcript'

type HandoffSource = { chainId: string; answerSource?: SessionFollowUpTranscriptSource }
type HandoffSourceResolver = (rule: SessionFollowUpRule) => HandoffSource | undefined
let resolver: HandoffSourceResolver | undefined

export function installSessionHandoffSource(source: HandoffSourceResolver): void {
  resolver = source
}

export function resolveSessionHandoffSource(rule: SessionFollowUpRule): HandoffSource | undefined {
  return resolver?.(rule)
}
