import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const JEV_COMMAND_SPECS: CommandSpec[] = [
  ...(['status', 'on', 'off'] as const).map((action): CommandSpec => ({
    path: ['jev', action],
    summary:
      action === 'status'
        ? 'Read this runtime’s JEV control and capability'
        : `Turn JEV ${action} for this runtime’s TypeSafe calls`,
    usage: `omni jev ${action} [--json]`,
    allowedFlags: [...GLOBAL_FLAGS],
    examples: [`omni jev ${action} --json`],
    notes: [
      'Targets the selected runtime. Environment kill switches still win. Turning JEV on preserves each feature’s own gates; it does not authorize actions or enable LLM fallback.'
    ]
  })),
  {
    path: ['jev', 'request'],
    summary: 'Request an advisory JEV reading from one of six fixed recipes, no LLM escalation',
    usage: 'omni jev request --file <request.json> [--jev off|auto|on|request] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'jev'],
    examples: ['omni jev request --file evidence-review.json --json'],
    notes: [
      'The JSON file contains recipeId and state. Recipes: work_routing {task}, evidence_review {claim, source}, advertising_review {copy, offer}, support_triage {message}, retrieval_review {query, passage}, lead_fit {lead, criteria}. Each field 1-6000 characters; state at most 12 KB.',
      'Reads a file on the CLI machine. Forwarded SSH/WSL shells reject file input; use a local CLI with --environment for a paired host.',
      'Default request is one-off and never changes the master switch. Off makes no provider call. A host/environment disable cannot be overridden by a request.',
      'Outputs native probabilities and provenance. UNKNOWN/unavailable stays explicit; no model escalation or external action occurs.',
      'Every result, including off and unavailable ones, is kept as jev-request:<request_id> in the selected runtime’s private structured decision records; storage reports saved or failed. support_triage, retrieval_review and lead_fit need a runtime with jev.request.v2; an older runtime must be updated.',
      'For versioned cross-company packets, workflow packs, optional escalation and paired evaluations use the documented jev-lab framework and improvement lab.'
    ]
  },
  {
    path: ['jev', 'rubrics', 'list'],
    summary: 'List built-in and saved rubrics from the shared UI library',
    usage: 'omni jev rubrics list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni jev rubrics list --json'],
    notes: [
      'Targets the selected runtime’s existing rubric library. Older runtimes require an update.'
    ]
  },
  {
    path: ['jev', 'rubrics', 'save'],
    summary: 'Save a reusable custom rubric in the existing UI library',
    usage: 'omni jev rubrics save (--file <rubric.json> | --input-stdin) [--replace] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'input-stdin', 'replace'],
    examples: [
      'omni jev rubrics save --file rubric.json --json',
      'cat rubric.json | omni jev rubrics save --input-stdin --json'
    ],
    notes: [
      'JSON: {name, instructions, kind?}. Name limit 80 characters; instructions limit 6000. Existing saved names require --replace; built-ins cannot be overwritten.',
      'Saved rubrics appear in the existing UI picker. This does not change criteria frozen in earlier runs.',
      'Forwarded SSH/WSL shells must use --input-stdin; --file never reads a colliding controller file. Input limit 48 KB.'
    ]
  },
  {
    path: ['jev', 'rubrics', 'evaluate'],
    summary: 'Evaluate supplied work against a reusable rubric with one advisory JEV call',
    usage:
      'omni jev rubrics evaluate (--file <evaluation.json> | --input-stdin) [--jev off|auto|on|request] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'input-stdin', 'jev'],
    examples: [
      'omni jev rubrics evaluate --file evaluation.json --json',
      'cat evaluation.json | omni jev rubrics evaluate --input-stdin --json'
    ],
    notes: [
      'JSON: {rubric, task, response, evidence?: {status, text}}. Rubric is a library value or unique name. Task limit 6000 characters; response 30000; evidence text 6000; total input 48 KB.',
      'Evidence status is verified, missing, stale, conflicting or unverified. Declared nonverified evidence returns UNKNOWN without inference. Without evidence, only supplied task and work are evaluated; external claims are not verified.',
      'One-off request is the default. Off makes no provider call; host/environment kill switches win. No model escalation, workflow generation or action authorization occurs.',
      'Scores are predictions, not verified quality. Explicit unknown/unavailable results remain unknown. Result storage status and key identify the selected runtime’s existing structured decision records.',
      'Credentials belong to the selected runtime. Forwarded SSH/WSL agents pipe --input-stdin; no controller file or other runtime fallback occurs.'
    ]
  },
  {
    path: ['jev', 'records', 'list'],
    summary: 'List the selected runtime’s JEV call ledger rows, newest first',
    usage: 'omni jev records list [--since <ISO>] [--caller <id>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since', 'caller', 'limit'],
    examples: [
      'omni jev records list --json',
      'omni jev records list --since 2026-10-03 --caller jev.rubrics.evaluate --limit 20 --json'
    ],
    notes: [
      'One summary per jev-call/1 row (one row per JEV call attempt, including not_called dry runs): record_key, caller, transport, deadline, status, provider_status, reason, elapsed time and how many outcome rows it has. Default limit 50, maximum 1000.',
      'Rows are hash-only: no task, response, evidence, prompt or passage text. --since takes an ISO 8601 date or UTC time and keeps rows that started at or after it.',
      'Needs a runtime with jev.records.v1; an older runtime must be updated.'
    ]
  },
  {
    path: ['jev', 'records', 'export'],
    summary: 'Export the JEV call and outcome rows as NDJSON',
    usage: 'omni jev records export [--since <ISO>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since'],
    examples: ['omni jev records export --since 2026-10-02 --json > jev-rows.ndjson'],
    notes: [
      'Prints one JSON object per line: every jev-call/1 row, oldest file first, then every jev-outcome/1 row. --since narrows the call rows only; outcome rows are always exported in full.',
      'A call row is appended when its call finishes and carries the start time, so overlap --since windows. Dedupe call rows by record_key, and outcome rows by record_key, question_id, labeler and recorded_at.',
      'Errors go to stderr with exit code 1, so stdout only ever holds rows.',
      'Needs a runtime with jev.records.v1; an older runtime must be updated.'
    ]
  },
  {
    path: ['jev', 'outcome'],
    summary: 'Append an independent outcome label to one JEV record',
    usage: 'omni jev outcome <record_key> (--file <outcome.json> | --input-stdin) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'file', 'input-stdin'],
    positionalArgs: ['key'],
    examples: [
      'omni jev outcome jev-rubric:<request_id> --file outcome.json --json',
      'cat outcome.json | omni jev outcome jev-request:<request_id> --input-stdin --json'
    ],
    notes: [
      'JSON: {question_id?, label, evidence_level, source, labeler, blind, recorded_at?, correction_minutes?, note?}. evidence_level is ground_truth, verification or cross_check; source is human, verified_outcome or model_reference. label is a short string, number or boolean; recorded_at is ISO 8601 UTC and defaults to now.',
      'labeler is session:<session or agent id> or sha256:<lowercase hex SHA-256 of the person’s lowercased email>. A raw email address is refused and never stored.',
      'Appends one jev-outcome/1 row; a correction is a new row. The record must exist on the selected runtime, and the same record_key, question_id, labeler and recorded_at is refused as a duplicate.',
      'A label comes from a person or a verified check, never from the agent that made the prediction. model_reference rows are reported apart from quality totals.',
      'Forwarded SSH/WSL shells must pipe --input-stdin. Needs a runtime with jev.records.v1.'
    ]
  }
]
