import type { LocalWorkflowSource } from './local-workflow-view'

/** A settled run's answer; `appendix` is the app's own part of a run that reads pages. */
export type LocalWorkflowResult = {
  /** The final answer exactly as the model wrote it. */
  markdown: string
  /** Rendered apart from `markdown`, so no model Markdown can hide or forge it. */
  appendix?: string
  sources: LocalWorkflowSource[]
  coverage: string[]
}
