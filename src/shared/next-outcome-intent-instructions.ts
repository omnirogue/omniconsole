const NEXT_OUTCOME_BIND_ONLY = 'Multiple outcomes do not authorize fan-out or additional agents.'
const NEXT_OUTCOME_REVIEWER_ACTION =
  'A requested agent reviewer is an action for that agent whose instruction quotes the review request, with a report condition whose target is that action.id. Optional reviewPlans entries are {id,outcomeId,actionIds:[review action IDs],maxRounds,repairActionId?,adversarial?}; the host compiles the real Next reviewer steps and removes those actions to prevent duplicate dispatch. Counts, rounds and adversarial settings must be explicit user choices; more than one round needs an explicitly requested repair action. PR, merge and deploy finishes still require the user-authorized outcome route.'

function nextOutcomeAgentInstructionParagraphs(scope: string, reviewers: string): string[] {
  return [
    'When the user prompt already defines a finish, bind it without requiring the user to open Next.',
    'Run `omni outcome context --json` from this current source terminal. A dispatch worker passes its existing --dispatch-capability on both context and commit; an ordinary source uses its current hook launch claim automatically. The host authenticates your current launch/dispatch identity and returns the authorized prompt, chain, revision, existing outcomes, and definition schema. On Linux use the installed `omni-ide` executable when `omni` is unavailable.',
    'Infer the minimum complete set from that prompt and current user authority. This is your reasoning task: do not treat keyword matching, a session label, process exit, or a generated note as inference or evidence.',
    `Write JSON with exactly the required fields {expectedRevision, sourcePrompt, outcomes} and optional sessionFinish/reviewPlans; copy the returned prompt and revision exactly. Each outcome uses the returned strict definition schema. Retain all requested obligations, stable existing IDs, exact file IDs/paths/URLs, repository identities, separate working/merge target branches, and per-outcome dependsOn. ${scope}`,
    'Carry the actual instructions in executable actions using a scoped exact quote from the authorized source prompt for each action. Do not repeat the entire multi-outcome prompt in every action; that could repeat a completed external action. A report file is evidence only when the requested deliverable is that report. Publish, release, linked Drive update, send, merge, and deploy require their actual supported destination/receipt verifier and existing authority. Never substitute a local note, echo command, arbitrary successful command, or self-asserted receipt. If verifier, access, or authority is unavailable, report the specific blocker; do not commit a fake executable outcome.',
    'Review-only work returns persisted reviewer findings without editing the primary deliverable or adding a writer. Preserve every other unfinished outcome across handoffs. AI cannot silently remove committed obligations.',
    reviewers,
    'For an explicit person delivery, context returns handoffs resolved against the signed-in roster. Use that exact person.id as both recipientId and target of a handoff condition, in its own human-handoff outcome with actions: []; the host creates its delivery step. Use dependsOn for work that must finish first. A returned review request also needs a review condition for that same person. Ask one question for unresolvedRecipients or missing exact files; never guess a recipient ID. If files were requested, retain their exact file conditions; paths must occur in the source prompt or existing committed outcomes. Transcript consent and its source identity are derived by the host from the explicit request. If handoffError is present, report that refusal; if handoffs is absent, this host does not support chat handoffs.',
    'Waits ("wait for X, then Y"): context returns `waits` the host parsed from the prompt, people resolved to roster `persons` (ask ONE question for `unresolved` people or a person wait with no channel). Put the waiting in its own outcome (never beside an action: actions run before conditions are checked) with finish "complete", actions: [], no instructions field, one kind:"event" condition per person or thing: {id, kind:"event", label:"Uma approves on Slack", target:<same words>, event:{source, match, personId, ref, since}}. slack/email: first run `omni outcome ask --person <persons[].id> --via slack|email --text "<the ask, from the user\'s words>" --json` (a real send; only for the channel and staff member the user named), then ref=handle and since=asked_at; if the ask is refused, file the wait without ref (since=now) and tell the person it did not go out. jira: ref=issue key, since=now (ISO). signin: ref=app key, since=now. github: source "github", match "merged" or "review", ref=the PR URL in the prompt. time: source "time", match "at", at=ISO. session (wait for another session\'s result): run `omni outcome wait --on-session <pane|ref> --json` and use the event it prints (source "session", match "result", ref=that pane key); never this conversation itself. "If no answer by T, ask me": deadline=T (ISO) and onDeadline "ask-owner" on those waits. The work after it is its own outcome (no instructions field): dependsOn the wait outcome, one action whose instruction copies the user\'s own words exactly (never reworded) with route:"same-session" (this conversation continues with the receipts), conditions [{id, kind:"session", target:chain.sourcePaneKey}]. "…, then close/save this session" is sessionFinish. File only waits context returned. Never wait, sleep or poll yourself: end your turn after filing; OmniConsole brings the conversation back. After committing, show the plan back once: "Waiting for: …" / "Then: …". If the person later says keep waiting, continue anyway or cancel, run `omni outcome wait --choice keep-waiting|continue|cancel`.',
    'When the user explicitly chooses what happens to this session, optional sessionFinish is {action:"me"}, {action:"save"}, or {action:"end"}; saving a file is not session consent. For a session-finish-only request, use one complete outcome with conditions:[{id:"source_done",kind:"session",target:chain.sourcePaneKey}], actions:[], and no instructions field. This waits for the source instead of creating a writer. Preserve every existing unfinished outcome; saving or ending happens only after all outcomes finish.',
    'Commit with `omni outcome commit --body-file <json-file> --json` (or `--body-file -` via stdin on SSH). The CLI rechecks current source identity and revision and commits the same set exposed by the editable Next lock. A refusal leaves the prior set intact. Do not retry an uncertain action as a fresh action.',
    'Saving binds work; it does not prove success. Continue the authorized source work. The existing execution host verifies conditions and owns continuation; do not start a new engine or poller.'
  ]
}

export const NEXT_OUTCOME_AGENT_INSTRUCTIONS = nextOutcomeAgentInstructionParagraphs(
  NEXT_OUTCOME_BIND_ONLY,
  NEXT_OUTCOME_REVIEWER_ACTION
).join('\n\n')

const NEXT_OUTCOME_TEAM_REVIEWERS =
  'Reviewers belong in team review steps with their reviewers and rounds, not in actions or reviewPlans. PR, merge and deploy finishes still require the user-authorized outcome route.'

/** Same binding rules, with the one grant the user's launch-time "Plan the team" consent adds. */
export function nextOutcomeTeamPlanAgentInstructions(teamRules: string): string {
  return nextOutcomeAgentInstructionParagraphs(
    'The user consented to an agent-planned team at launch: add the optional `team` field described below; it is the only fan-out this consent authorizes.',
    `${NEXT_OUTCOME_TEAM_REVIEWERS}\n\n${teamRules}`
  ).join('\n\n')
}

export const NEXT_OUTCOME_DISCOVERY_MARKER = '<!-- omni-outcome-source-v1 -->'

export function nextOutcomeDiscoveryInstruction(cli: string, capabilityFlag = ''): string {
  return `${NEXT_OUTCOME_DISCOVERY_MARKER}\nIf this task already carries committed outcomes, execute those obligations without creating another outcome set. Otherwise, if the user prompt defines a finish, run \`${cli} outcome context${capabilityFlag} --json\` from this source terminal before finishing. It returns the authenticated prompt, existing outcomes, strict definition schema, and instructions for binding every authorized outcome without opening Next. Follow those instructions to commit; preserve all obligations and destinations. Saving is not success, and multiple outcomes grant no extra agents or publication authority. If this host cannot bind outcomes, report the specific refusal and continue authorized source work.`
}

export function hasNextOutcomeDiscovery(prompt: string): boolean {
  return prompt.includes(NEXT_OUTCOME_DISCOVERY_MARKER)
}

export function prependNextOutcomeDiscovery(prompt: string, cli: string): string {
  return !prompt.trim() || hasNextOutcomeDiscovery(prompt)
    ? prompt
    : `${nextOutcomeDiscoveryInstruction(cli)}\n\n${prompt}`
}
