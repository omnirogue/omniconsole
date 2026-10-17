import type { LocalWorkflowDraft } from './local-workflow-draft'
import {
  workflowContextAddSources,
  workflowContextSourceKey,
  type WorkflowContextSource
} from './workflow-context-sources'

/** The three choices the editor offers. */
export type WorkflowContextChoice = 'auto' | 'sources' | 'frozen'

/**
 * The editor's choice for a draft. Older drafts' workspace-read reads as auto; a started draft of
 * "Chosen files, folders and repos" is workspace-read with the workspace left out, and reads back
 * as that choice.
 */
export function workflowContextChoice(
  draft: Pick<LocalWorkflowDraft, 'access' | 'includeWorkspace'>
): WorkflowContextChoice {
  if (draft.access === 'frozen' || draft.access === 'sources') {
    return draft.access
  }
  return draft.access === 'workspace-read' && draft.includeWorkspace === false ? 'sources' : 'auto'
}

/** Auto always reads the workspace; chosen sources include it only when ticked. */
export function workflowContextIncludesWorkspace(
  draft: Pick<LocalWorkflowDraft, 'access' | 'includeWorkspace'>
): boolean {
  return workflowContextChoice(draft) === 'auto' || draft.includeWorkspace === true
}

/**
 * The draft a Start sends. Access on the wire stays workspace-read or frozen, so a run with
 * nothing extra is exactly the run older builds made; only extra sources, or a workspace left
 * out, add the context fields. `detected`: what the request names, for a Run pressed before the
 * editor offered it.
 */
export function workflowContextDraftForStart(
  draft: LocalWorkflowDraft,
  detected: readonly WorkflowContextSource[] = []
): { draft: LocalWorkflowDraft } | { error: 'nothing-chosen' } {
  const { contextSources: chosen = [], includeWorkspace: _included, ...rest } = draft
  const choice = workflowContextChoice(draft)
  if (choice === 'frozen') {
    return { draft: { ...rest, access: 'frozen' } }
  }
  const sources = choice === 'auto' ? workflowContextAddSources(chosen, detected) : chosen
  const includeWorkspace = workflowContextIncludesWorkspace(draft)
  if (!sources.length && !includeWorkspace) {
    return { error: 'nothing-chosen' }
  }
  if (!sources.length) {
    return { draft: { ...rest, access: 'workspace-read' } }
  }
  return {
    draft: { ...rest, access: 'workspace-read', contextSources: sources, includeWorkspace }
  }
}

/**
 * What the host copies for a Start: undefined when agents read the workspace itself (or nothing),
 * otherwise the sources, each once, and whether the workspace joins them. Invalid sources stay in
 * so admission refuses them rather than silently reading less.
 */
export function workflowContextRequest(
  draft: Pick<LocalWorkflowDraft, 'access' | 'contextSources' | 'includeWorkspace'>
): { sources: WorkflowContextSource[]; includeWorkspace: boolean } | undefined {
  if (draft.access === 'frozen') {
    return undefined
  }
  const keys = new Set<string>()
  const sources = (draft.contextSources ?? []).filter((source) => {
    const key = workflowContextSourceKey(source)
    return keys.has(key) ? false : (keys.add(key), true)
  })
  const includeWorkspace = workflowContextIncludesWorkspace(draft)
  return sources.length || !includeWorkspace ? { sources, includeWorkspace } : undefined
}
