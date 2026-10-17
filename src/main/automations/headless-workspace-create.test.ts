import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'

const repoPath = path.join('tmp', 'omni')

const repo: Repo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'omni',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git',
  executionHostId: 'ssh:ssh-target-1'
}

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly review',
  prompt: 'Review changes',
  precheck: null,
  agentId: 'codex',
  runContext: {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'ssh:ssh-target-1',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    path: repoPath
  },
  sourceContext: null,
  projectId: 'legacy-repo-1',
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-target-1',
  schedulerOwner: 'remote_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: 'origin/main',
  setupDecision: 'skip',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1,
  enabled: true,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1
}

describe('headless automation workspace create args', () => {
  it('stamps automation provenance for serve-mode new-per-run workspaces', () => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation,
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo,
      createdAt: 123
    })

    expect(args.startupPrompt).toContain('routine-result')
    expect(args).toMatchObject({
      repoSelector: 'repo-1',
      name: 'auto-nightly-review-run-20260102T0304',
      baseBranch: 'origin/main',
      setupDecision: 'skip',
      activate: false,
      createdWithAgent: 'codex',
      startupAgent: 'codex',
      startupPrompt: expect.stringContaining('Review changes'),
      telemetrySource: 'unknown',
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'automation-1',
        automationNameSnapshot: 'Nightly review',
        automationRunId: 'run-1',
        automationRunTitleSnapshot: 'Nightly review run',
        createdAt: 123,
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-target-1',
        projectId: 'project-1',
        repoId: 'repo-1',
        hostId: 'ssh:ssh-target-1'
      }
    })
  })

  it('falls back to skip for legacy automations without a saved setup decision', () => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, setupDecision: undefined },
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo
    })

    expect(args.setupDecision).toBe('skip')
  })

  it.each([
    { promptOverride: undefined, expected: 'Review changes' },
    { promptOverride: null, expected: 'Review changes' },
    { promptOverride: '', expected: '' },
    { promptOverride: 'Apply the selected change', expected: 'Apply the selected change' }
  ])('resolves the per-run prompt override $promptOverride', ({ promptOverride, expected }) => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation,
      run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 1, promptOverride },
      repo
    })

    expect(args.startupPrompt).toContain('Routine definition context:')
    expect(args.startupPrompt?.split('End routine definition context.\n\n')[1]).toBe(expected)
    expect(automation.prompt).toBe('Review changes')
  })

  it('adds the structured contract to the launch without changing the saved prompts', () => {
    const configuredAutomation: Automation = {
      ...automation,
      structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
    }
    const run = {
      id: 'run-1',
      title: 'Nightly review run',
      scheduledFor: 1,
      promptOverride: 'Classify the selected change'
    }
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation: configuredAutomation,
      run,
      repo
    })

    expect(args.startupPrompt).toContain('Classify the selected change')
    expect(args.startupPrompt).toContain('classification.v1')
    expect(args.startupPrompt).not.toContain('Review changes')
    expect(configuredAutomation.prompt).toBe('Review changes')
    expect(run.promptOverride).toBe('Classify the selected change')
  })

  it('carries the template this host resolved, with the result contract still last', () => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, agentTemplateId: 'reviewer' },
      run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 1 },
      repo,
      agentTemplate: { name: 'Reviewer', instructions: 'REVIEW ONLY' }
    })

    expect(args.startupPrompt).toMatch(/^Routine definition context:/)
    expect(args.startupPrompt).toMatch(
      /\n\n---\n\nStanding instructions for this session \(agent template "Reviewer"; follow them throughout\):\nREVIEW ONLY\n\nWhatever the standing instructions above say, still end the output with the routine-result block/
    )
  })
})
