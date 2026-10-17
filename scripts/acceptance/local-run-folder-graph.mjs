/**
 * The Phase 2 acceptance graph: research → plan → three parallel implements →
 * synthesize → verify, with a DIFFERENT actor on every node so the run shows that
 * the actor (agent + model + effort + account profile) is a per-node choice.
 *
 * It lives beside the acceptance script so a test can admit the exact same graph the
 * script would send: an acceptance graph the runner would refuse is not evidence.
 */
export function localRunAcceptanceGraph(workspacePath) {
  return {
    workspacePath,
    maxConcurrent: 3,
    nodes: [
      {
        id: 'research',
        actor: { agent: 'claude', model: 'opus', effort: 'high' },
        presetId: 'research',
        objective: 'Read brief.md and list every clip in ./clips with what it shows.',
        deps: []
      },
      {
        id: 'plan',
        actor: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
        presetId: 'plan',
        objective: 'Plan three different 30 second cuts from the clips.',
        deps: ['research']
      },
      {
        id: 'cut-a',
        actor: { agent: 'codex' },
        presetId: 'implement',
        objective:
          'Produce cut A: the fastest, hook-first version. Write the edit list and script.',
        deps: ['plan']
      },
      {
        id: 'cut-b',
        actor: { agent: 'claude', model: 'sonnet' },
        presetId: 'implement',
        objective: 'Produce cut B: the demo-led version. Write the edit list and script.',
        deps: ['plan']
      },
      {
        id: 'cut-c',
        actor: { agent: 'claude', model: 'opus' },
        presetId: 'implement',
        objective: 'Produce cut C: the story-led version. Write the edit list and script.',
        deps: ['plan']
      },
      {
        id: 'assemble',
        actor: { agent: 'codex', model: 'gpt-5.5' },
        presetId: 'synthesize',
        objective: 'Combine the three cuts into one final edit list and one script.',
        deps: ['cut-a', 'cut-b', 'cut-c']
      },
      {
        id: 'check',
        actor: { agent: 'claude', model: 'opus', effort: 'high' },
        presetId: 'verify',
        objective:
          'Check the assembled cut against brief.md and report PASS or FAIL per requirement.',
        deps: ['assemble']
      }
    ]
  }
}
