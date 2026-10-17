import type { AgentTemplateSettings } from '../../shared/agent-templates'
import type { SessionPrepSteps } from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepReuse } from './session-prep-reuse'
import type { SessionPrepStore } from './session-prep-store'

export type SessionPrepServiceOptions = {
  host: SessionPrepHost
  steps: () => SessionPrepSteps
  store: SessionPrepStore
  now?: () => number
  newId?: () => string
  reuse?: SessionPrepReuse
  /** Host templates are read when planning and rendering each brief. */
  agentTemplates?: () => AgentTemplateSettings | undefined
}
