import { describe, expect, it, vi } from 'vitest'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { bindProjectLaunch, projectBriefForLaunch } from './session-launch-project'

const launch: SessionProjectLaunch = {
  project: { folderId: 'f1', name: 'Ads' },
  projectLine: 'Project: Ads (company omnirogue)',
  host: { id: 'ssh:box', label: 'box' },
  attachments: [{ id: 'slite:1', kind: 'slite', title: 'Ads plan', content: 'Plan body' }],
  inherited: [
    { id: 'slite:1', kind: 'slite', title: 'Ads plan', state: 'inherited' },
    { id: 'file:1', kind: 'file', title: 'brief.md', state: 'not-on-host', hostId: 'local' }
  ],
  notOnHost: [{ id: 'file:1', kind: 'file', title: 'brief.md', hostId: 'local' }],
  agent: {
    templateId: 'reviewer',
    name: 'Reviewer',
    digest: 'a'.repeat(12),
    instructions: 'Review it'
  },
  error: null
}

function client(call: RuntimeClient['call']): RuntimeClient {
  return { call, isRemote: false } as unknown as RuntimeClient
}

const args = { folderId: 'f1', host: 'ssh:box', worktree: 'id:wt-1', prompt: 'Fix the bug' }

describe('projectBriefForLaunch', () => {
  it('builds the brief with the project line first and lists what the host lacks', async () => {
    const call = vi.fn(async () => ({ result: launch }))
    const brief = await projectBriefForLaunch(client(call as never), args)
    expect(call).toHaveBeenCalledWith('sessionProjects.resolveLaunch', {
      folder: 'f1',
      host: 'ssh:box',
      worktreeId: 'wt-1'
    })
    expect(brief.prompt.split('\n\n').slice(0, 3)).toEqual([
      'Project: Ads (company omnirogue)',
      'Fix the bug',
      'Review it'
    ])
    expect(brief.prompt).toContain('Plan body')
    expect(brief.warnings).toEqual(['Not on box: brief.md (file), left out of this session.'])
    expect(brief.report?.notOnHost).toEqual(launch.notOnHost)
    expect(brief.report?.agent).toEqual({
      templateId: 'reviewer',
      name: 'Reviewer',
      digest: 'a'.repeat(12)
    })
    expect(JSON.stringify(brief.report)).not.toContain('Plan body')
  })

  it('keeps only the attachments the manifest sent, so a restart does not add duplicate agent text', async () => {
    const attachments = [
      ...launch.attachments,
      {
        id: 'agent-copy',
        kind: 'instructions' as const,
        title: 'Reviewer copy',
        content: 'Review it'
      },
      { ...launch.attachments[0]!, id: 'duplicate-doc' }
    ]
    const call = vi.fn(async () => ({ result: { ...launch, attachments } }))
    const brief = await projectBriefForLaunch(client(call as never), args)
    expect(brief.prompt.match(/Review it/g)).toHaveLength(1)
    expect(brief.prompt.match(/Plan body/g)).toHaveLength(1)
    expect(brief.items).toEqual(launch.attachments)
  })

  it('launches the brief as given, with a warning, on a runtime without projects', async () => {
    const call = vi.fn(async () => {
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    const brief = await projectBriefForLaunch(client(call as never), args)
    expect(brief.prompt).toBe('Fix the bug')
    expect(brief.warnings[0]).toMatch(/predates projects/)
  })

  it('refuses before launching when the inherited context is too large', async () => {
    const call = vi.fn(async () => ({
      result: { ...launch, error: 'This session’s context is full.' }
    }))
    await expect(projectBriefForLaunch(client(call as never), args)).rejects.toThrow(
      /context is full/
    )
  })

  it('leaves a folder in no project alone', async () => {
    const call = vi.fn(async () => ({ result: null }))
    expect(await projectBriefForLaunch(client(call as never), args)).toEqual({
      prompt: 'Fix the bug',
      manifest: null,
      report: null,
      warnings: [],
      items: []
    })
  })

  it('warns with the notes of documents it could not re-read, and hands on what it inherited', async () => {
    const notes = ['Kept the saved copy of “Ads plan”: Slite is not connected.']
    const call = vi.fn(async () => ({ result: { ...launch, notes } }))
    const brief = await projectBriefForLaunch(client(call as never), args)
    expect(brief.warnings).toEqual([
      'Not on box: brief.md (file), left out of this session.',
      ...notes
    ])
    expect(brief.items).toEqual(launch.attachments)
  })
})

describe('bindProjectLaunch', () => {
  it('keeps the inherited context on the new tab', async () => {
    const call = vi.fn(async () => ({ result: { bound: true } }))
    expect(await bindProjectLaunch(client(call as never), 'term_1', launch.attachments)).toBeNull()
    expect(call).toHaveBeenCalledWith('sessionProjects.bindLaunch', {
      terminal: 'term_1',
      items: launch.attachments
    })
  })

  it('warns when the window could not keep it, and never fails the launch', async () => {
    for (const call of [
      vi.fn(async () => ({ result: { bound: false } })),
      vi.fn(async () => {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      })
    ]) {
      expect(await bindProjectLaunch(client(call as never), 'term_1', launch.attachments)).toMatch(
        /restart will not re-deliver it/
      )
    }
  })

  it('asks nothing for an empty context or a paired CLI', async () => {
    const call = vi.fn()
    expect(await bindProjectLaunch(client(call as never), 'term_1', [])).toBeNull()
    const remote = { call, isRemote: true } as unknown as RuntimeClient
    expect(await bindProjectLaunch(remote, 'term_1', launch.attachments)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
