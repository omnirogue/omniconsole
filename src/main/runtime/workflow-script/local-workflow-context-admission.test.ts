import { describe, expect, it } from 'vitest'
import {
  createLocalWorkflowGraphDraft,
  type LocalWorkflowDraft
} from '../../../shared/local-workflow-draft'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { admitWorkflowContext } from './local-workflow-context-admission'
import { graphContextNote, graphContextNoteFields } from './graph/graph-context-note'

const local = { id: 'w', path: '/work/app', label: 'app', executionHost: 'local' as const }

function draft(fields: Partial<LocalWorkflowDraft>): LocalWorkflowDraft {
  return {
    ...createLocalWorkflowGraphDraft({
      prompt: 'task',
      graph: { spec: normalizeWorkflowSpec({ template: 'custom', steps: [] }), team: [] }
    }),
    ...fields
  }
}

describe('admitting what agents read', () => {
  it('reads the workspace itself when nothing else was chosen', () => {
    expect(
      admitWorkflowContext({
        draft: draft({ access: 'workspace-read' }),
        workspace: local,
        hasCheck: true
      })
    ).toEqual({ problems: [] })
  })

  it('asks for a copy of the chosen sources on this computer', () => {
    const sources = [{ kind: 'path' as const, path: '/a/b' }]
    expect(
      admitWorkflowContext({
        draft: draft({ access: 'workspace-read', contextSources: sources, includeWorkspace: true }),
        workspace: local,
        hasCheck: false
      })
    ).toEqual({ context: { sources, includeWorkspace: true }, problems: [] })
  })

  it('refuses sources for a workspace that runs elsewhere, and invalid ones', () => {
    const { problems } = admitWorkflowContext({
      draft: draft({
        access: 'workspace-read',
        contextSources: [{ kind: 'github', repo: 'not a repo' }]
      }),
      workspace: { ...local, executionHost: undefined },
      hasCheck: false
    })
    expect(problems).toEqual([
      'A chosen file, folder or repo is not valid. Remove it and choose it again.',
      'Chosen files, folders and repos need a workspace that runs on this computer.'
    ])
  })

  it('keeps a check with the real workspace only', () => {
    const check = (fields: Partial<LocalWorkflowDraft>) =>
      admitWorkflowContext({ draft: draft(fields), workspace: local, hasCheck: true }).problems
    expect(check({ access: 'frozen' })).toEqual([
      'The check runs in this workspace: choose "Find it from my description" to use a check.'
    ])
    expect(
      check({ access: 'workspace-read', contextSources: [{ kind: 'path', path: '/a/b' }] })
    ).toEqual([
      'The check runs in this workspace itself: remove the chosen files, folders and repos to use a check.'
    ])
    expect(check({ access: 'workspace-read', includeWorkspace: false })).toContain(
      'The check runs in this workspace: include this workspace to use a check.'
    )
  })
})

describe('what agents are told about a context folder', () => {
  it('lists each top-level folder and where it came from', () => {
    expect(
      graphContextNote([
        { kind: 'workspace', folder: 'workspace' },
        { kind: 'path', path: '/Users/maintainer/notes', folder: 'notes' },
        {
          kind: 'github',
          repo: 'acme/api',
          folder: 'github/acme__api@default',
          commit: '0123456789abcdef0123'
        }
      ])
    ).toBe(
      'The current directory holds read-only copies of what the person chose: workspace/ (the project the person has open); notes (a copy of /Users/maintainer/notes); github/acme__api@default/ (GitHub acme/api at its default branch, commit 0123456789ab).'
    )
  })

  it('adds nothing for a run that reads the workspace itself', () => {
    const host = { host: {} } as Parameters<typeof graphContextNoteFields>[0]
    expect(graphContextNoteFields(host)).toEqual({})
  })
})
