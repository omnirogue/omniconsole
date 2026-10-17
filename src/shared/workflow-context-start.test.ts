import { describe, expect, it } from 'vitest'
import { createLocalWorkflowGraphDraft, type LocalWorkflowDraft } from './local-workflow-draft'
import { localWorkflowAnchorSchema } from './local-workflow-session-schema'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import {
  workflowContextChoice,
  workflowContextDraftForStart,
  workflowContextIncludesWorkspace,
  workflowContextRequest
} from './workflow-context-start'

function draft(fields: Partial<LocalWorkflowDraft> = {}): LocalWorkflowDraft {
  return {
    ...createLocalWorkflowGraphDraft({
      prompt: 'task',
      graph: { spec: normalizeWorkflowSpec({ template: 'custom', steps: [] }), team: [] }
    }),
    ...fields
  }
}

describe('what agents read, from the draft', () => {
  it('opens new drafts on "Find it from my description"', () => {
    expect(draft().access).toBe('workspace-read')
    expect(workflowContextChoice(draft())).toBe('auto')
  })

  it('reads an older workspace-read or missing access as auto with nothing else chosen', () => {
    for (const access of ['workspace-read', undefined] as const) {
      const old = draft({ access })
      expect(workflowContextChoice(old)).toBe('auto')
      expect(workflowContextIncludesWorkspace(old)).toBe(true)
      expect(workflowContextRequest(old)).toBeUndefined()
      expect(workflowContextDraftForStart(old)).toEqual({
        draft: { ...old, access: 'workspace-read' }
      })
    }
  })

  it('still parses a saved draft from before sources were a choice', () => {
    const saved = { ...draft(), access: 'workspace-read' }
    delete (saved as Partial<LocalWorkflowDraft>).contextSources
    const parsed = localWorkflowAnchorSchema.parse({
      preset: 'council',
      prompt: 'task',
      draft: saved
    })
    expect(parsed.draft?.access).toBe('workspace-read')
    expect(parsed.draft?.contextSources).toBeUndefined()
  })

  it('keeps chosen sources through a save', () => {
    const saved = draft({
      access: 'sources',
      contextSources: [
        { kind: 'path', path: '/a/b' },
        { kind: 'github', repo: 'acme/api', ref: 'dev' }
      ],
      includeWorkspace: false
    })
    const parsed = localWorkflowAnchorSchema.parse({
      preset: 'council',
      prompt: 'task',
      draft: saved
    })
    expect(parsed.draft?.contextSources).toEqual(saved.contextSources)
    expect(parsed.draft?.includeWorkspace).toBe(false)
  })

  it('sends workspace-read with the sources, and adds what the task names only in auto', () => {
    const named = [{ kind: 'github' as const, repo: 'acme/api' }]
    expect(workflowContextDraftForStart(draft(), named)).toEqual({
      draft: {
        ...draft(),
        access: 'workspace-read',
        contextSources: named,
        includeWorkspace: true
      }
    })
    const chosen = draft({ access: 'sources', contextSources: [{ kind: 'path', path: '/a/b' }] })
    const { contextSources: _sources, ...rest } = chosen
    expect(workflowContextDraftForStart(chosen, named)).toEqual({
      draft: {
        ...rest,
        access: 'workspace-read',
        contextSources: [{ kind: 'path', path: '/a/b' }],
        includeWorkspace: false
      }
    })
  })

  it('reads a started draft back as the choice it was started from', () => {
    for (const choice of ['auto', 'sources'] as const) {
      const sent = workflowContextDraftForStart(
        draft({ access: choice, contextSources: [{ kind: 'path', path: '/a/b' }] })
      )
      expect('draft' in sent && workflowContextChoice(sent.draft)).toBe(choice)
    }
  })

  it('refuses a Start with nothing to read, and drops sources for Knowledge only', () => {
    expect(workflowContextDraftForStart(draft({ access: 'sources' }))).toEqual({
      error: 'nothing-chosen'
    })
    const frozen = draft({ access: 'frozen', contextSources: [{ kind: 'path', path: '/a/b' }] })
    const sent = workflowContextDraftForStart(frozen)
    expect('draft' in sent && sent.draft.contextSources).toBe(undefined)
    expect(workflowContextRequest(frozen)).toBeUndefined()
  })

  it('asks the host for a copy only when there is more than the workspace', () => {
    expect(
      workflowContextRequest({
        access: 'workspace-read',
        contextSources: [{ kind: 'path', path: '/a/b' }],
        includeWorkspace: true
      })
    ).toEqual({ sources: [{ kind: 'path', path: '/a/b' }], includeWorkspace: true })
    expect(workflowContextRequest({ access: 'workspace-read', includeWorkspace: false })).toEqual({
      sources: [],
      includeWorkspace: false
    })
  })
})
