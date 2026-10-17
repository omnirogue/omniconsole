import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  SESSION_FOLDERS_TIMEOUT_ERROR
} from '../../shared/session-folder-cli'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import type { SessionPrepHost } from './session-prep-host'
import { withSessionPrepProject } from './session-prep-project'

const launch: SessionProjectLaunch = {
  project: { folderId: 'f1', name: 'Ads' },
  projectLine: 'Project: Ads',
  host: { id: 'ssh:box', label: 'box' },
  attachments: [{ id: 'note', kind: 'instructions', title: 'Be brief', content: 'Be brief' }],
  inherited: [],
  notOnHost: [{ id: 'file:1', kind: 'file', title: 'brief.md', hostId: 'local' }],
  agent: {
    templateId: 'reviewer',
    name: 'Reviewer',
    digest: 'a'.repeat(12),
    instructions: 'Review it'
  },
  error: null
}

const host = (projectLaunch: SessionPrepHost['projectLaunch']) =>
  ({ projectLaunch }) as unknown as SessionPrepHost
const args = {
  folder: 'Ads',
  hostId: 'ssh:box',
  worktreeId: 'wt',
  prompt: 'Task',
  templated: false
}

describe('withSessionPrepProject', () => {
  it('prefixes the project, adds its agent and context, and notes what the host lacks', async () => {
    const result = await withSessionPrepProject(host(vi.fn(async () => launch)), args)
    expect(result.prompt.split('\n\n').slice(0, 3)).toEqual(['Project: Ads', 'Task', 'Review it'])
    expect(result.notes).toEqual(['Inherits project “Ads”', 'Not on box: brief.md (left out)'])
  })

  it('keeps a chosen template in charge instead of the project agent', async () => {
    const result = await withSessionPrepProject(host(vi.fn(async () => launch)), {
      ...args,
      templated: true
    })
    expect(result.prompt).not.toContain('Review it')
  })

  it('says so when the window is closed, and stays quiet for a folder in no project', async () => {
    const closed = vi.fn(async () => {
      throw new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)
    })
    expect((await withSessionPrepProject(host(closed), args)).notes[0]).toMatch(/not read/)
    const timedOut = vi.fn(async () => {
      throw new Error(SESSION_FOLDERS_TIMEOUT_ERROR)
    })
    expect((await withSessionPrepProject(host(timedOut), args)).notes[0]).toMatch(/not read/)
    const unknown = vi.fn(async () => {
      throw new Error('No folder named “New”.')
    })
    expect(await withSessionPrepProject(host(unknown), args)).toEqual({ prompt: 'Task', notes: [] })
    expect(await withSessionPrepProject(host(undefined), args)).toEqual({
      prompt: 'Task',
      notes: []
    })
  })
})
