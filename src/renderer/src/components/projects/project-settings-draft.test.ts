import { describe, expect, it } from 'vitest'
import { agentTemplateDigest, type AgentTemplate } from '../../../../shared/agent-templates'
import {
  emptyProjectSettings,
  projectSettingsError,
  type ProjectSettings
} from '../../../../shared/project-settings'
import {
  changedProjectAgentTemplate,
  defaultCoordinatorDraft,
  projectAgentTemplates,
  projectCoordinatorFromDraft,
  projectRepoChoices,
  projectSettingsDraftFor,
  projectSettingsFromDraft,
  withDefaultProjectAgent,
  withProjectAgent
} from './project-settings-draft'

const template = (id: string, instructions: string | null): AgentTemplate => ({
  id,
  name: id,
  description: '',
  instructions,
  builtin: false
})

const saved: ProjectSettings = {
  repos: [{ gitIdentity: 'github.com/acme/app' }],
  attachments: [],
  agents: [],
  hostPolicy: ['local', 'ssh:box'],
  company: 'Acme',
  createdBy: 'person',
  createdAt: 100,
  updatedAt: 200
}

describe('projectSettingsFromDraft', () => {
  it('stamps a new record as made by a person now', () => {
    const draft = {
      ...projectSettingsDraftFor(null),
      company: '  ',
      domain: ' ads '
    }
    const built = projectSettingsFromDraft(draft, null, 500)
    expect(built).toEqual({
      ok: true,
      settings: {
        repos: [],
        attachments: [],
        agents: [],
        hostPolicy: 'as-named',
        domain: 'ads',
        // The chat: the launcher's default provider, as a team where that is offered.
        coordinator: { launch: { agent: 'claude', team: true } },
        createdBy: 'person',
        createdAt: 500,
        updatedAt: 500
      }
    })
    expect(built.ok && projectSettingsError(built.settings)).toBeNull()
  })

  it('keeps the first save time and round-trips the chosen computers', () => {
    const draft = projectSettingsDraftFor(saved)
    expect(draft.hostMode).toBe('hosts')
    const built = projectSettingsFromDraft(draft, saved, 900)
    // A record saved before the chat pick gets the default one on its next save.
    expect(built.ok && built.settings).toEqual({
      ...saved,
      coordinator: { launch: { agent: 'claude', team: true } },
      updatedAt: 900
    })
  })

  it("round-trips the project's chat and keeps it bound", () => {
    const coordinated: ProjectSettings = {
      ...saved,
      coordinator: { launch: { agent: 'claude', team: true }, sessionKey: 'provider-key' }
    }
    const built = projectSettingsFromDraft(projectSettingsDraftFor(coordinated), coordinated, 900)
    expect(built.ok && built.settings).toEqual({ ...coordinated, updatedAt: 900 })
  })

  it("keeps the project's Jira issues, which the dialog does not edit", () => {
    const linked: ProjectSettings = {
      ...saved,
      coordinator: { launch: { agent: 'claude', team: true } },
      tasks: [
        {
          provider: 'jira',
          cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
          issue_id: '10001',
          issue_key: 'ADS-12',
          project_key: 'ADS'
        }
      ]
    }
    const built = projectSettingsFromDraft(projectSettingsDraftFor(linked), linked, 900)
    expect(built.ok && built.settings).toEqual({ ...linked, updatedAt: 900 })
  })

  it('gives a project saved before the chat pick the launcher’s default provider', () => {
    expect(projectSettingsDraftFor(saved, 'codex').coordinator).toEqual({
      agent: 'codex',
      team: true
    })
    expect(projectSettingsDraftFor(saved, 'blank').coordinator).toEqual({
      agent: 'claude',
      team: true
    })
    expect(defaultCoordinatorDraft('antigravity')).toEqual({ agent: 'antigravity', team: false })
  })

  it('keeps picks while another mode is chosen and refuses an empty pick', () => {
    const auto = {
      ...projectSettingsDraftFor(saved),
      hostMode: 'auto' as const
    }
    const built = projectSettingsFromDraft(auto, saved, 900)
    expect(built.ok && built.settings.hostPolicy).toBe('auto')
    expect(auto.hosts).toEqual(['local', 'ssh:box'])
    const empty = { ...auto, hostMode: 'hosts' as const, hosts: [] }
    expect(projectSettingsFromDraft(empty, saved, 900).ok).toBe(false)
  })
})

describe('projectCoordinatorFromDraft', () => {
  const recorded = {
    launch: { agent: 'claude' as const, model: 'opus', effort: 'max', team: true },
    sessionKey: 'provider-key'
  }

  it('writes the picked model and effort, and keeps the running chat bound', () => {
    expect(
      projectCoordinatorFromDraft(
        { agent: 'claude', team: false, model: 'sonnet', effort: 'high' },
        recorded
      )
    ).toEqual({
      launch: { agent: 'claude', model: 'sonnet', effort: 'high' },
      sessionKey: 'provider-key'
    })
  })

  it('round-trips a recorded model and effort through the draft', () => {
    const settings: ProjectSettings = { ...emptyProjectSettings(1), coordinator: recorded }
    const draft = projectSettingsDraftFor(settings).coordinator
    expect(draft).toEqual({ agent: 'claude', team: true, model: 'opus', effort: 'max' })
    expect(projectCoordinatorFromDraft(draft, recorded)).toEqual(recorded)
  })

  it('a team only where one is offered', () => {
    expect(projectCoordinatorFromDraft({ agent: 'codex', team: true }, recorded)).toEqual({
      launch: { agent: 'codex', team: true },
      sessionKey: 'provider-key'
    })
    expect(projectCoordinatorFromDraft({ agent: 'antigravity', team: true }, undefined)).toEqual({
      launch: { agent: 'antigravity' }
    })
  })
})

describe('project agents', () => {
  const writer = template('writer', 'Write well.')
  const coder = template('coder', 'Code well.')

  it('offers only templates with text, and adds each once', () => {
    expect(
      projectAgentTemplates([template('default', null), template('empty', ' '), writer])
    ).toEqual([writer])
    const agents = withProjectAgent(withProjectAgent([], writer), writer)
    expect(agents.map((agent) => agent.templateId)).toEqual(['writer'])
  })

  it('moves the chosen agent first as the default', () => {
    const agents = withProjectAgent(withProjectAgent([], writer), coder)
    expect(withDefaultProjectAgent(agents, 'coder').map((agent) => agent.templateId)).toEqual([
      'coder',
      'writer'
    ])
  })

  it('names the current template when its text moved on', () => {
    const [agent] = withProjectAgent([], writer)
    expect(changedProjectAgentTemplate(agent!, [writer])).toBeNull()
    const edited = template('writer', 'Write better.')
    expect(changedProjectAgentTemplate(agent!, [edited])).toBe(edited)
    expect(agent!.digest).toBe(agentTemplateDigest('Write well.'))
  })
})

describe('projectRepoChoices', () => {
  it('dedupes by identity and marks a repo without a remote', () => {
    const remote = { canonicalKey: 'github.com/acme/app' } as never
    const choices = projectRepoChoices([
      { path: '/a', displayName: 'app', gitRemoteIdentity: remote },
      { path: '/b', displayName: 'app copy', gitRemoteIdentity: remote },
      { path: '/c', displayName: 'notes', gitRemoteIdentity: null }
    ])
    expect(choices.map((choice) => [choice.label, choice.hasRemote])).toEqual([
      ['app', true],
      ['notes', false]
    ])
  })
})
