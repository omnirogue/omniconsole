import { describe, expect, it } from 'vitest'
import {
  projectAgentForLaunch,
  projectLaunchPrompt,
  projectRepoItemId,
  resolveProjectLaunch,
  type ProjectLaunchHost,
  type ProjectLaunchInput
} from './project-launch-inheritance'
import { emptyProjectSettings, type ProjectSettings } from './project-settings'
import type { SessionContextAttachment } from './session-context-attachments'
import { sessionPromptContent } from './session-prompt-content'

const slite: SessionContextAttachment = {
  id: 'slite:abc',
  kind: 'slite',
  title: 'Ads plan',
  content: 'Plan text',
  capturedAt: 1
}
const localFile: SessionContextAttachment = {
  id: 'file:local:/Users/maintainer/brief.md',
  kind: 'file',
  title: 'brief.md',
  uri: '/Users/maintainer/brief.md',
  hostId: 'local'
}
const skillByName: SessionContextAttachment = {
  id: 'skill-name:jira',
  kind: 'skill',
  title: 'jira'
}
const note: SessionContextAttachment = {
  id: 'instructions:1',
  kind: 'instructions',
  title: 'Be brief',
  content: 'Be brief'
}

function host(overrides: Partial<ProjectLaunchHost> = {}): ProjectLaunchHost {
  return {
    hostId: 'local',
    label: 'This computer',
    repoCheckout: (identity) =>
      identity === 'github.com/omnirogue/omni-ide' ? '/Users/maintainer/omni-ide' : null,
    skill: (name) =>
      name === 'jira' ? { path: '/Users/maintainer/.claude/skills/jira/SKILL.md' } : null,
    ...overrides
  }
}

function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    ...emptyProjectSettings(1),
    repos: [{ gitIdentity: 'github.com/omnirogue/omni-ide' }],
    attachments: [slite, localFile, skillByName],
    ...overrides
  }
}

function input(overrides: Partial<ProjectLaunchInput> = {}): ProjectLaunchInput {
  return {
    project: { folderId: 'f1', name: 'Ads', settings: settings() },
    launch: [],
    session: [],
    removed: [],
    host: host(),
    templateId: null,
    ...overrides
  }
}

describe('resolveProjectLaunch', () => {
  it('inherits in order: project, then launch context, then session additions', () => {
    const result = resolveProjectLaunch(input({ launch: [note], session: [{ ...note, id: 'x' }] }))
    expect(result.attachments.map((item) => item.id)).toEqual([
      projectRepoItemId('github.com/omnirogue/omni-ide'),
      'slite:abc',
      localFile.id,
      'skill-name:jira',
      'instructions:1',
      'x'
    ])
    expect(result.notOnHost).toEqual([])
    expect(result.error).toBeNull()
  })

  it('lets a later layer replace a project item with the same id', () => {
    const edited = { ...slite, content: 'Session copy' }
    const result = resolveProjectLaunch(input({ session: [edited] }))
    expect(result.attachments.find((item) => item.id === slite.id)?.content).toBe('Session copy')
    expect(result.attachments.filter((item) => item.id === slite.id)).toHaveLength(1)
  })

  it('applies per-session removals last and reports them as removed', () => {
    const result = resolveProjectLaunch(
      input({ removed: [slite.id, projectRepoItemId('github.com/omnirogue/omni-ide')] })
    )
    expect(result.attachments.map((item) => item.id)).toEqual([localFile.id, 'skill-name:jira'])
    expect(
      result.inherited.filter((item) => item.state === 'removed').map((item) => item.id)
    ).toEqual([projectRepoItemId('github.com/omnirogue/omni-ide'), slite.id])
  })

  it('resolves a repo by identity to that host checkout', () => {
    const repo = resolveProjectLaunch(input()).attachments[0]!
    expect(repo).toMatchObject({
      kind: 'folder',
      uri: '/Users/maintainer/omni-ide',
      hostId: 'local'
    })
  })

  it('resolves a skill by name to the target host copy', () => {
    const skill = resolveProjectLaunch(input()).attachments.find((item) => item.kind === 'skill')
    expect(skill).toMatchObject({
      uri: '/Users/maintainer/.claude/skills/jira/SKILL.md',
      hostId: 'local'
    })
  })

  it('delivers a skill by name, marked unverified, when the host cannot be read', () => {
    const result = resolveProjectLaunch(
      input({ host: host({ hostId: 'ssh:box', label: 'box', skill: () => 'unknown' }) })
    )
    expect(result.inherited.find((item) => item.id === 'skill-name:jira')?.state).toBe('unverified')
    const skill = result.attachments.find((item) => item.kind === 'skill')
    expect(skill).toMatchObject({ title: 'jira', hostId: 'ssh:box' })
    expect(skill?.uri).toBeUndefined()
  })

  it('lists host-bound items the SSH target lacks as not on host, and leaves them out', () => {
    const result = resolveProjectLaunch(
      input({
        host: host({
          hostId: 'ssh:box',
          label: 'box',
          repoCheckout: () => null,
          skill: () => null
        })
      })
    )
    expect(result.notOnHost).toEqual([
      {
        id: projectRepoItemId('github.com/omnirogue/omni-ide'),
        kind: 'repo',
        title: 'github.com/omnirogue/omni-ide',
        hostId: null
      },
      { id: localFile.id, kind: 'file', title: 'brief.md', hostId: 'local' },
      { id: 'skill-name:jira', kind: 'skill', title: 'jira', hostId: null }
    ])
    // Host-independent kinds still travel.
    expect(result.attachments.map((item) => item.id)).toEqual(['slite:abc'])
  })

  it('uses a replacement the person picked for an item this host lacks', () => {
    const stand: SessionContextAttachment = {
      id: 'file:ssh:box:/home/sal/brief.md',
      kind: 'file',
      title: 'brief.md',
      uri: '/home/sal/brief.md',
      hostId: 'ssh:box'
    }
    const result = resolveProjectLaunch(
      input({
        host: host({ hostId: 'ssh:box', label: 'box' }),
        replaced: { [localFile.id]: stand }
      })
    )
    expect(result.inherited.find((item) => item.id === localFile.id)?.state).toBe('replaced')
    expect(result.attachments).toContainEqual(stand)
    expect(result.notOnHost.map((item) => item.id)).not.toContain(localFile.id)
  })

  it("opens a file or folder inside a project repo from the target's own checkout", () => {
    const inRepo = (path: string): SessionContextAttachment => ({
      id: `file:local:/Users/maintainer/omni-ide/${path}`,
      kind: path ? 'file' : 'folder',
      title: path || 'omni-ide',
      uri: `/Users/maintainer/omni-ide/${path}`,
      hostId: 'local',
      repo: { gitIdentity: 'github.com/omnirogue/omni-ide', path }
    })
    const fromWindows = {
      ...inRepo('docs/brief.md'),
      id: 'file:windows',
      repo: { gitIdentity: 'github.com/omnirogue/omni-ide', path: 'docs\\brief.md' }
    }
    const items = [inRepo('docs/brief.md'), inRepo(''), inRepo('../secrets.txt'), fromWindows]
    const on = (hostId: string, checkout: string | null) =>
      resolveProjectLaunch(
        input({
          project: { folderId: 'f1', name: 'Ads', settings: settings({ attachments: items }) },
          host: host({ hostId, label: hostId, repoCheckout: () => checkout })
        })
      )

    const box = on('ssh:box', '/home/sal/omni-ide')
    expect(box.attachments).toContainEqual({
      ...items[0],
      uri: '/home/sal/omni-ide/docs/brief.md',
      hostId: 'ssh:box'
    })
    expect(box.attachments).toContainEqual({
      ...items[1],
      uri: '/home/sal/omni-ide',
      hostId: 'ssh:box'
    })
    expect(box.attachments.find((item) => item.id === 'file:windows')?.uri).toBe(
      '/home/sal/omni-ide/docs/brief.md'
    )
    // The launcher says which repo a file travels by; the repo row itself needs no such note.
    expect(box.inherited.find((item) => item.id === items[0].id)).toEqual({
      id: items[0].id,
      kind: 'file',
      title: 'docs/brief.md',
      state: 'inherited',
      repo: 'github.com/omnirogue/omni-ide'
    })
    expect(box.inherited.find((item) => item.kind === 'repo')?.repo).toBeUndefined()
    // A stored path that climbs out of the repo stays on its own computer.
    expect(box.notOnHost.map((item) => item.id)).toEqual([items[2].id])

    const windows = on('runtime:studio', 'C:\\Users\\sal\\omni-ide')
    expect(windows.attachments.find((item) => item.id === items[0].id)?.uri).toBe(
      'C:/Users/maintainer/omni-ide/docs/brief.md'
    )
    // No checkout there: the item is host-bound, as it is without `repo`.
    expect(on('ssh:other', null).notOnHost.map((item) => item.id)).toEqual([
      projectRepoItemId('github.com/omnirogue/omni-ide'),
      ...items.map((item) => item.id)
    ])
  })

  it('drops a not-on-host item the person dropped instead of listing it', () => {
    const result = resolveProjectLaunch(
      input({ host: host({ hostId: 'ssh:box', label: 'box' }), removed: [localFile.id] })
    )
    expect(result.notOnHost.map((item) => item.id)).not.toContain(localFile.id)
    expect(result.inherited.find((item) => item.id === localFile.id)?.state).toBe('removed')
  })

  it('reports an over-full context instead of throwing', () => {
    const many = Array.from({ length: 41 }, (_, index) => ({ ...note, id: `n${index}` }))
    expect(resolveProjectLaunch(input({ session: many })).error).toMatch(/40|Too big|array/i)
  })
})

describe('projectAgentForLaunch', () => {
  const reviewer = {
    templateId: 'reviewer',
    name: 'Reviewer',
    digest: 'a'.repeat(12),
    instructions: 'Review'
  }
  const writer = {
    templateId: 'writer',
    name: 'Writer',
    digest: 'b'.repeat(12),
    instructions: 'Write'
  }

  it('uses the project default agent when the launcher picked none', () => {
    expect(projectAgentForLaunch([reviewer, writer], null)).toBe(reviewer)
    expect(projectAgentForLaunch([reviewer, writer], 'default')).toBe(reviewer)
  })

  it('uses the project copy of the template the launcher picked', () => {
    expect(projectAgentForLaunch([reviewer, writer], 'writer')).toBe(writer)
  })

  it('leaves another picked template to the launcher', () => {
    expect(projectAgentForLaunch([reviewer], 'researcher')).toBeNull()
  })
})

describe('projectLaunchPrompt', () => {
  const launch = {
    project: { folderId: 'f1', name: 'Ads' },
    projectLine: 'Project: Ads (company omnirogue)',
    attachments: [note],
    inherited: [{ id: note.id, kind: note.kind, title: note.title, state: 'inherited' as const }],
    notOnHost: [],
    agent: {
      templateId: 'reviewer',
      name: 'Reviewer',
      digest: '000000000000',
      instructions: 'Review carefully'
    },
    roster: [
      { templateId: 'reviewer', name: 'Reviewer' },
      { templateId: 'writer', name: 'Writer' }
    ]
  }

  it('puts the project line first and titles still come from the task', () => {
    const prompt = projectLaunchPrompt(launch, { prompt: 'Fix the checkout bug', hostLabel: null })
    expect(
      prompt.startsWith(
        'Project: Ads (company omnirogue)\n\nFix the checkout bug\n\nReview carefully'
      )
    ).toBe(true)
    expect(prompt).toContain('--- BEGIN ATTACHED SESSION CONTEXT ---')
    expect(sessionPromptContent(prompt, 20)).toBe('Fix the checkout bug')
  })

  it('points at the project and names the other agents instead of pasting them', () => {
    const prompt = projectLaunchPrompt(launch, { prompt: '', hostLabel: null })
    expect(prompt).toContain('omni folder project --folder f1')
    expect(prompt).toContain('subagents: Writer;')
    expect(prompt).not.toContain('subagents: Reviewer')
  })

  it('sends a brief identical to the agent text once', () => {
    const brief = { ...note, content: 'Review carefully' }
    const prompt = projectLaunchPrompt(
      { ...launch, attachments: [brief, { ...brief, id: 'instructions:2' }] },
      { prompt: '', hostLabel: null }
    )
    expect(prompt.split('Review carefully')).toHaveLength(2)
    expect(prompt).not.toContain('BEGIN ATTACHED SESSION CONTEXT')
  })
})
