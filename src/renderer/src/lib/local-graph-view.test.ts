import { describe, expect, it } from 'vitest'
import { pipelineFixture } from '@/components/build-review/build-review-test-fixture'
import { localRunFixture, localRunNodeFixture } from '@/components/local-run/local-run-test-fixture'
import { buildReviewGraphView, workspacePathFromSelector } from './local-graph-build-review'
import { exportLocalGraphView } from './local-graph-export'
import { localGraphEventLanes, localRunGraphView } from './local-graph-view'
import { layoutConsoleWorkflow } from './console-workflow-layout'

describe('local run → graph model', () => {
  it('keeps the runner’s nodes, dependency edges and stored states', () => {
    const view = localRunGraphView(localRunFixture())
    expect(view.source).toBe('local-run')
    expect(view.stage).toBe('running')
    expect(view.nodes.map((node) => node.id)).toEqual(['cut-a', 'cut-b', 'fold'])
    expect(view.nodes.map((node) => node.state)).toEqual(['completed', 'running', 'queued'])
    expect(view.nodes.map((node) => node.after)).toEqual([[], [], ['cut-a', 'cut-b']])
    expect(view.nodes[2].objective).toBe('Fold the cuts together')
    expect(view.nodes[0].actor).toEqual({ agent: 'codex' })
    // The layout Lane 3 uses must accept the projected edges unchanged.
    const layout = layoutConsoleWorkflow(
      view.nodes.map((node) => ({ key: node.id, after: node.after }))
    )
    expect(layout.ok && layout.columns).toEqual([['cut-a', 'cut-b'], ['fold']])
  })

  it('shows the workspace FOLDER each node ran in and the files it produced', () => {
    const view = localRunGraphView(localRunFixture())
    expect(view.workspacePath).toBe('/Users/me/Webinar')
    expect(view.nodes[0].workspacePath).toBe('/Users/me/Webinar/.omni/runs/run_1/task_a')
    expect(view.nodes[0].producedFiles).toEqual([
      '/Users/me/Webinar/.omni/runs/run_1/task_a/cut-a.mp4'
    ])
    expect(view.nodes[0].manifestPath).toBe('/Users/me/Webinar/.omni/runs/run_1/task_a/manifest.md')
    // A node the runner never placed falls back to the workspace root, never to a guess.
    expect(view.nodes[2].workspacePath).toBe('/Users/me/Webinar')
    expect(view.nodes[2].producedFiles).toEqual([])
  })

  it('names the child workspace a git-isolated node was given', () => {
    const view = localRunGraphView(
      localRunFixture({
        workspaceKind: 'git',
        nodes: [
          localRunNodeFixture({
            id: 'cut-a',
            placement: { worktree: 'new-child', name: 'run_1-cut-a' }
          })
        ]
      })
    )
    expect(view.nodes[0].childWorkspaceName).toBe('run_1-cut-a')
    expect(view.nodes[0].workspacePath).toBe('/Users/me/Webinar')
    expect(view.workspaceKind).toBe('git')
  })

  it('carries the gate and the worker question a person has to answer', () => {
    const view = localRunGraphView(
      localRunFixture({
        nodes: [
          localRunNodeFixture({
            id: 'cut-a',
            state: 'needs-input',
            gateId: 'gate_1',
            gateQuestion: 'Publish this cut?'
          }),
          localRunNodeFixture({
            id: 'cut-b',
            state: 'needs-input',
            question: {
              source: 'mailbox',
              messageId: 'msg_1',
              question: 'Which codec?',
              options: ['h264'],
              askedAt: '2026-09-10T10:00:00.000Z'
            }
          })
        ]
      })
    )
    expect(view.nodes[0].gateQuestion).toBe('Publish this cut?')
    expect(view.nodes[1].question?.question).toBe('Which codec?')
  })

  it('never invents a repeat edge for a DAG the runner walks once', () => {
    expect(localRunGraphView(localRunFixture()).loops).toEqual([])
  })

  it('lanes the stored events by node, keeping the run’s own lane', () => {
    const lanes = localGraphEventLanes(localRunGraphView(localRunFixture()))
    expect(lanes.map((lane) => lane.node)).toEqual(['cut-a', 'cut-b', 'fold', 'run'])
    expect(lanes[0].events.map((event) => event.text)).toEqual(['cut-a produced 1 file'])
    expect(lanes[3].events.map((event) => event.text)).toEqual(['Created 3 task(s)'])
  })
})

describe('Build + Review → graph model', () => {
  it('draws the builder, its reviewer and the loop back with a round counter', () => {
    const view = buildReviewGraphView(pipelineFixture({ round: 2, maxReviewRounds: 5 }))
    expect(view.source).toBe('build-review')
    expect(view.nodes.map((node) => node.id)).toEqual(['builder', 'reviewer'])
    expect(view.nodes.map((node) => node.after)).toEqual([[], ['builder']])
    expect(view.loops).toEqual([{ from: 'reviewer', to: 'builder', round: 2, maxRounds: 5 }])
    expect(view.nodes.every((node) => node.round === 2)).toBe(true)
    // The loop is not a dependency: the layout still sees an acyclic graph.
    const layout = layoutConsoleWorkflow(
      view.nodes.map((node) => ({ key: node.id, after: node.after }))
    )
    expect(layout.ok && layout.columns).toEqual([['builder'], ['reviewer']])
  })

  it('reads states and files from the worker rows, and the open question wins', () => {
    const view = buildReviewGraphView(pipelineFixture())
    expect(view.nodes[0].state).toBe('completed')
    expect(view.nodes[0].producedFiles).toEqual(['src/search.tsx'])
    // The reviewer is running AND has an unanswered question: needs-input beats reviewing.
    expect(view.nodes[1].state).toBe('needs-input')
    expect(view.nodes[1].question?.question).toBe('Should search include archived items?')
    expect(view.nodes[1].actor).toEqual({ agent: 'claude', model: 'opus', effort: 'high' })
  })

  it('shows a reviewing worker as reviewing when nothing is waiting on a person', () => {
    const view = buildReviewGraphView(pipelineFixture({ pendingQuestion: null }))
    expect(view.nodes[1].state).toBe('reviewing')
  })

  it('gives every reviewer its own node and its own loop edge', () => {
    const base = pipelineFixture()
    const view = buildReviewGraphView(
      pipelineFixture({
        pendingQuestion: null,
        reviewers: [base.reviewer, { ...base.reviewer, choice: { agent: 'grok' } }]
      })
    )
    expect(view.nodes.map((node) => node.id)).toEqual(['builder', 'reviewer-1', 'reviewer-2'])
    expect(view.loops.map((loop) => loop.from)).toEqual(['reviewer-1', 'reviewer-2'])
  })

  it('shows the workspace folder path, never the runtime selector', () => {
    expect(buildReviewGraphView(pipelineFixture()).workspacePath).toBe('/workspace')
    expect(
      buildReviewGraphView(pipelineFixture(), { workspacePath: '/Users/me/Folder' }).workspacePath
    ).toBe('/Users/me/Folder')
    expect(workspacePathFromSelector('id:folder:42')).toBeNull()
  })

  it('projects the round the pipeline is actually on', () => {
    const base = pipelineFixture()
    const view = buildReviewGraphView(
      pipelineFixture({
        round: 2,
        rounds: [
          { number: 1, builder: base.builder, reviewers: [base.reviewer] },
          {
            number: 2,
            builder: { ...base.builder, status: 'running', report: null },
            reviewers: [{ ...base.reviewer, status: 'pending' }]
          }
        ]
      })
    )
    expect(view.nodes[0].state).toBe('running')
    expect(view.nodes[1].state).toBe('needs-input')
    expect(view.loops[0].round).toBe(2)
  })
})

describe('local graph export', () => {
  it('exports the stored view as JSON', () => {
    const view = localRunGraphView(localRunFixture())
    expect(JSON.parse(exportLocalGraphView(view, 'json'))).toEqual(view)
  })

  it('exports Mermaid with states, folder paths, dependency edges and produced files', () => {
    const mermaid = exportLocalGraphView(localRunGraphView(localRunFixture()), 'mermaid')
    expect(mermaid).toContain('flowchart LR')
    // The separator is escaped exactly as Lane 3 escapes it, so Mermaid renders it.
    expect(mermaid).toContain(
      'n0["cut-a #183; completed #183; local #183; /Users/me/Webinar/.omni/runs/run_1/task_a"]'
    )
    expect(mermaid).toContain('n0 --> n2')
    expect(mermaid).toContain('n1 --> n2')
    expect(mermaid).toContain(
      '%% produced by cut-a: /Users/me/Webinar/.omni/runs/run_1/task_a/cut-a.mp4'
    )
    expect(mermaid).not.toContain('-.->')
  })

  it('exports a Build + Review loop as a dotted repeat edge carrying the round', () => {
    const mermaid = exportLocalGraphView(
      buildReviewGraphView(pipelineFixture({ round: 2, maxReviewRounds: 5 })),
      'mermaid'
    )
    expect(mermaid).toContain('n0 --> n1')
    expect(mermaid).toContain('n1 -.->|round 2/5| n0')
  })

  it('refuses to export a graph whose edges do not lay out', () => {
    const view = localRunGraphView(localRunFixture())
    view.nodes[0].after = ['ghost']
    expect(() => exportLocalGraphView(view, 'mermaid')).toThrow(/missing stage/)
  })
})
