import { DISCOVER_OMNIOS_MAX_FINDINGS, type DiscoverOmniosRun } from './discover-omnios-page'
import { DISCOVER_DECISIONS_FILE } from './discover-omnios-decisions'

/**
 * What the session that brings a finished Discover run to OmniOS is told, and the scripts it runs.
 * The session publishes from its own terminal, so OmniOS ties the page to it: it waits for the
 * answer as any session that asked does (live, then asleep), wakes on it, and starts what the person
 * picked. Titles and the person's words never pass through a command line the session types: the
 * scripts carry each finding's title quoted here, and read the words from files.
 */

/** The model the delivering session runs on: it publishes, waits, then writes contracts. */
export const DISCOVER_OMNIOS_DESK = { agent: 'claude', model: 'sonnet', effort: 'medium' } as const

export const DISCOVER_OMNIOS_QUESTION = 'Which of these should start?'

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/** Runs the composed command; on success keeps its JSON reply in `$1` (the link, the session). */
const RUN_AND_KEEP = [
  'keep="$1"',
  'shift',
  'if out=$("${ORCA_CLI_COMMAND:-omni}" "$@"); then',
  '  printf \'%s\\n\' "$out" > "$keep"',
  '  printf \'%s\\n\' "$out"',
  'else',
  '  status=$?',
  '  printf \'%s\\n\' "$out"',
  '  exit "$status"',
  'fi'
]

const header = (usage: string): string[] => [
  '#!/bin/sh',
  `# ${usage}`,
  'set -e',
  'cd "$(dirname "$0")"',
  'run() {',
  ...RUN_AND_KEEP.map((line) => `  ${line}`),
  '}'
]

/**
 * `publish.sh share|update "<reviewers>"`: shares or revises page.html for a decision, with the
 * team as its audience and no category: a category decides who may answer, and a guessed one is
 * worse than none (Decision rights, 2026-10-13). The question and summary are quoted here.
 */
export function discoverOmniosPublishScript(run: DiscoverOmniosRun): string {
  const review = [
    '--review',
    '--question',
    shellQuote(DISCOVER_OMNIOS_QUESTION),
    '--audience',
    'team',
    '--json'
  ]
  // Nothing to decide: a plain page, so nobody is asked.
  const ask = run.findings.length
    ? [
        'reviewers="${2:-}"',
        ...(run.requestedById
          ? [
              `requester=${shellQuote(run.requestedById)}`,
              'case ",$reviewers," in',
              '  *,"$requester",*) ;;',
              '  *) reviewers="${reviewers:+$reviewers,}$requester" ;;',
              'esac'
            ]
          : []),
        `set -- artifacts "$mode" "$file" ${review.join(' ')}`,
        'if [ -n "$summary" ]; then set -- "$@" --summary "$summary"; fi',
        'if [ -n "$reviewers" ]; then set -- "$@" --reviewers "$reviewers"; fi'
      ]
    : ['set -- artifacts "$mode" "$file" --audience team --json']
  return [
    ...header(
      'Publishes this Discover run’s OmniOS page. Usage: publish.sh share|update "<reviewers>"'
    ),
    'mode="${1:-share}"',
    'case "$mode" in share|update) ;; *) echo "publish.sh: share or update" >&2; exit 2 ;; esac',
    'page="${3:-1}"',
    `case "$page" in ${Array.from({ length: Math.max(1, Math.ceil(run.findings.length / DISCOVER_OMNIOS_MAX_FINDINGS)) }, (_, i) => i + 1).join('|')}) ;; *) echo "Invalid page" >&2; exit 2 ;; esac`,
    '"${ORCA_CLI_COMMAND:-omni}" workflow render-page findings.json --json > rendered.json',
    'file=page.html; keep=published.json',
    '[ "$page" = 1 ] || { file="page-$page.html"; keep="published-$page.json"; }',
    `summary=$(node -e ${shellQuote("process.stdout.write(JSON.parse(require('fs').readFileSync('findings.json','utf8')).summary || '')")})`,
    ...ask,
    // The reply names the page's link; omni workflow status reads it from published.json.
    'run "$keep" "$@"',
    ''
  ].join('\n')
}

/** `case` arms naming each finding by number, so a script refuses any other. */
const findingCases = (run: DiscoverOmniosRun, arm: (title: string) => string): string[] =>
  run.findings.map((finding) => `  ${finding.n}) ${arm(finding.title)} ;;`)

/** A successful CLI envelope still needs a terminal receipt before Start counts as launched. */
const LAUNCH_RECEIPT = `const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(r.ok!==true || typeof r.result?.operationId!=='string' || !r.result?.terminal?.handle) process.exit(1)`
const WORKTREE_RECEIPT = `const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const value=r.ok===true && r.result?.worktree?.[process.argv[2] || 'id']; if(typeof value!=='string' || !value) process.exit(1); process.stdout.write(value)`

/** Upserts finding n's pick into decisions.json, with the launch or run receipt once one exists. */
const DECIDE = `const fs=require('fs'); const [n,key,title,pick]=process.argv.slice(1); const read=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return null}}; const file=${JSON.stringify(DISCOVER_DECISIONS_FILE)}; const doc=read(file); const decisions=(Array.isArray(doc?.decisions)?doc.decisions:[]).filter((d)=>d?.n!==Number(n)); const entry={n:Number(n),key,title,pick,at:new Date().toISOString()}; const r=pick==='start'?read('started-'+n+'.json'):pick==='dig'?read('dug-'+n+'.json'):null; if(pick==='start'&&r?.ok===true&&typeof r.result?.operationId==='string'&&r.result?.terminal?.handle) entry.receipt={operationId:r.result.operationId,terminal:String(r.result.terminal.handle)}; if(pick==='dig'&&r?.ok===true&&typeof r.result?.executionId==='string') entry.receipt={executionId:r.result.executionId}; decisions.push(entry); decisions.sort((a,b)=>a.n-b.n); fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,decisions},null,2)+'\\n',{mode:0o600}); fs.renameSync(file+'.tmp',file)`

/** `decide.sh <n> start|dig|not-now`: records the person's pick for finding n (decisions.json). */
export function discoverOmniosDecideScript(run: DiscoverOmniosRun): string {
  return [
    ...header('Records the pick for one finding. Usage: decide.sh <n> start|dig|not-now'),
    'n="${1:-}"',
    'pick="${2:-}"',
    'case "$n" in',
    ...run.findings.map(
      (finding) =>
        `  ${finding.n}) key=${shellQuote(finding.key ?? '')}; title=${shellQuote(finding.title)} ;;`
    ),
    '  *) echo "decide.sh: there is no finding $n" >&2; exit 2 ;;',
    'esac',
    'case "$pick" in start|dig|not-now) ;; *) echo "decide.sh: start, dig or not-now" >&2; exit 2 ;; esac',
    `node -e ${shellQuote(DECIDE)} "$n" "$key" "$title" "$pick"`,
    ''
  ].join('\n')
}

/** A recording failure never blocks the action itself. */
const decide = (pick: string) =>
  `sh decide.sh "$n" ${pick} || echo "could not record the pick for finding $n" >&2`

/** Starts use a private worktree of the recorded commit on the workspace's execution host. */
export function discoverOmniosStartScript(run: DiscoverOmniosRun, workspacePath: string): string {
  const source = run.source
  const repoId = run.workspaceId?.includes('::') ? run.workspaceId.split('::')[0] : undefined
  const blocked =
    !source || !repoId
      ? 'This run has no recorded Git source. Run Discover on a registered Git workspace before Start.'
      : source.dirty
        ? 'Discover read uncommitted changes. Commit and push them, then run Discover again before Start.'
        : undefined
  return [
    ...header('Starts one finding’s work. Usage: start.sh <n> <contract.json>'),
    'n="${1:-}"',
    'contract="${2:-}"',
    'case "$n" in',
    ...findingCases(run, (title) => `title=${shellQuote(`Start: ${title}`.slice(0, 120))}`),
    '  *) echo "start.sh: there is no finding $n" >&2; exit 2 ;;',
    'esac',
    '[ -f "$contract" ] || { echo "start.sh: no contract file $contract" >&2; exit 2; }',
    decide('start'),
    `if [ -f "started-$n.json" ]; then node -e ${shellQuote(LAUNCH_RECEIPT)} "started-$n.json" || { echo "Start blocked: invalid launch receipt" >&2; exit 2; }; echo "Finding $n was already started:"; cat "started-$n.json"; exit 0; fi`,
    ...(blocked
      ? [`echo ${shellQuote(`Start blocked: ${blocked}`)} >&2`, 'exit 2']
      : [
          `workspace=${shellQuote(workspacePath)}`,
          `commit=${shellQuote(source!.commit)}`,
          `origin=${shellQuote(source!.origin ?? '')}`,
          'current_origin=$(git -C "$workspace" remote get-url origin 2>/dev/null || true)',
          '[ "$origin" = "$current_origin" ] || { echo "Start blocked: origin changed since Discover" >&2; exit 2; }',
          'if [ -n "$origin" ]; then',
          '  git -C "$workspace" fetch --prune origin "+refs/heads/*:refs/remotes/origin/*" || { echo "Start blocked: cannot verify pushed commit" >&2; exit 2; }',
          '  pushed=$(git -C "$workspace" for-each-ref --contains="$commit" --format="%(refname)" refs/remotes/origin/)',
          '  [ -n "$pushed" ] || { echo "Start blocked: Discover commit is not pushed to origin" >&2; exit 2; }',
          'fi',
          'if [ ! -f "start-worktree-$n.json" ]; then',
          `  run "start-worktree-$n.json" worktree create --repo ${shellQuote(`id:${repoId}`)} --name ${shellQuote(`discover-${run.executionId ?? 'run'}`)}-"$n" --base-branch "$commit" --no-parent --setup run --json`,
          'fi',
          `worktree=$(node -e ${shellQuote(WORKTREE_RECEIPT)} "start-worktree-$n.json") || { echo "Start blocked: missing worktree receipt" >&2; exit 2; }`,
          `path=$(node -e ${shellQuote(WORKTREE_RECEIPT)} "start-worktree-$n.json" path)`,
          'head=$(git -C "$path" rev-parse --verify HEAD) || { echo "Start blocked: cannot inspect created worktree" >&2; exit 2; }',
          '[ "$head" = "$commit" ] || { echo "Start blocked: created worktree is not at the Discover commit" >&2; exit 2; }',
          'run "start-attempt-$n.json" session launch --provider claude --contract "$contract" --title "$title" --title-origin generated --worktree "id:$worktree" --json',
          `node -e ${shellQuote(LAUNCH_RECEIPT)} "start-attempt-$n.json" || { echo "Start blocked: missing launch receipt; inspect the attempt before retrying" >&2; exit 2; }`,
          'mv "start-attempt-$n.json" "started-$n.json"',
          decide('start')
        ]),
    ''
  ].join('\n')
}

/** The caller supplies every finding selected Start; a refused Start keeps the page open. */
export function discoverOmniosCloseScript(): string {
  return [
    ...header(
      'Closes only after selected Starts have receipts. Usage: close.sh <note> <page> [started n ...]'
    ),
    'note="${1:?give a completion note}"',
    'page="${2:?give the page number}"',
    'case "$page" in *[!0-9]*|""|0) exit 2 ;; esac',
    'file=page.html; [ "$page" = 1 ] || file="page-$page.html"',
    'shift 2',
    'for n in "$@"; do',
    '  case "$n" in *[!0-9]*|"") echo "Invalid finding number" >&2; exit 2 ;; esac',
    `  node -e ${shellQuote(LAUNCH_RECEIPT)} "started-$n.json" || { echo "Action blocked: Start $n has no launch receipt; keep the page open and report the reason" >&2; exit 2; }`,
    'done',
    'run closed.json artifacts close "$file" --done --note "$note" --json',
    ''
  ].join('\n')
}

/**
 * `dig.sh <n> <brief.md> <words.txt> "<who answered>"`: a focused Discover on finding n in the
 * run's workspace, once, carrying the person's words from the file as they wrote them.
 */
export function discoverOmniosDigScript(run: DiscoverOmniosRun, workspacePath: string): string {
  return [
    ...header('Digs into one finding. Usage: dig.sh <n> <brief.md> <words.txt> "<who answered>"'),
    'n="${1:-}"',
    'brief="${2:-}"',
    'words="${3:-}"',
    'who="${4:-}"',
    'case "$n" in',
    ...findingCases(run, () => ':'),
    '  *) echo "dig.sh: there is no finding $n" >&2; exit 2 ;;',
    'esac',
    '[ -f "$brief" ] && [ -s "$words" ] && [ -n "$who" ] || { echo "dig.sh: give the brief, the words file and who answered" >&2; exit 2; }',
    'if [ -f "dug-$n.json" ]; then echo "Finding $n is already being dug into:"; cat "dug-$n.json"; exit 0; fi',
    decide('dig'),
    `set -- workflow run --template discover --depth quick --focus-finding ${shellQuote(run.executionId ?? '')}:"$n" --prompt-file "$brief" --worktree ${shellQuote(`path:${workspacePath}`)} --requested-by="$who" --request="$(cat "$words")" --no-follow --json`,
    ...(run.requestedById
      ? [`set -- "$@" --requested-by-id ${shellQuote(run.requestedById)}`]
      : []),
    'run "dug-$n.json" "$@"',
    decide('dig'),
    ''
  ].join('\n')
}

export function discoverOmniosBrief(run: DiscoverOmniosRun, folder: string): string {
  const kind = run.template === 'quick-discover' ? 'Quick Discover' : 'Discover'
  const asked = run.requestedBy
    ? `${run.requestedBy} asked for it${run.request ? `: "${run.request}"` : ''}.`
    : 'A person started it in OmniConsole.'
  const requester = run.requestedById ? '' : run.requestedBy ? `, plus ${run.requestedBy}` : ''
  const addressing = run.requestedById
    ? `publish.sh already adds ${run.requestedBy}, who asked, so <reviewers> lists only the people your standing instructions name. `
    : ''
  const file = (name: string) => `"${folder}/${name}"`
  if (!run.findings.length) {
    return [
      `Bring a finished ${kind} run to OmniOS: ${run.goal}`,
      '',
      `${asked} It found nothing worth acting on. Its files are in ${folder}.`,
      `Publish its page once, as a plain page with nothing to decide: bash ${file('publish.sh')} share "", then say the link in one line and stop.`
    ].join('\n')
  }
  const pages = Math.ceil(run.findings.length / DISCOVER_OMNIOS_MAX_FINDINGS)
  return [
    `Bring a finished ${kind} run to OmniOS and act on the answer: ${run.goal}`,
    '',
    `${asked} Its results are in ${folder}:`,
    '- page.html: the OmniOS page, ready to publish. Rebuilt from findings.json before every publish; never edit HTML.',
    "- findings.json: each finding's number, title, status, why, next step, evidence and recommended pick.",
    '- report.md: the full report.',
    '- publish.sh, actions.sh, decide.sh, start.sh, dig.sh, close.sh: the only way to publish and act. Never type a finding title or a person’s words into a command line yourself.',
    'Write every file you make (contracts, briefs, words) in that folder.',
    '',
    '1. Publish the page once:',
    `   bash ${file('publish.sh')} share "<reviewers>"`,
    `   ${addressing}<reviewers>: the people your standing instructions name for review pages${requester}, as emails or emp_ ids (never names: look a name up with list_employees), comma-separated; "" when none are named (the page then asks you). Say the link in one line, then wait. You stay live for a while, then sleep; the answer wakes you here.`,
    '2. When the answer arrives ("[OmniOS decision] …"):',
    '   - Approved: read the whole saved answer with omni artifacts status, not just the wake message. The page sends structured picks (number, key, pick); native multi-pick decisions send selected indices. Prepare one contract or Dig brief per selected finding, then run actions.sh for this page. It validates the current approved revision and starts every pick separately, once. Never combine findings into one session or start unticked findings.',
    `   - Changes requested: edit only summary, why, next, effort or risk in findings.json as requested. Preserve every finding's n, key, title, status, evidence and recommended pick. Then bash ${file('publish.sh')} update "<the same reviewers>" <page number>; code rebuilds the HTML and its edit keys. Wait again.`,
    '   - Rejected: stop and do nothing else.',
    '   Then, for each finding in order:',
    `   - Start: write contract-<n>.json, one JSON object with every field the implement template needs: objective (what to achieve and why, from its title, why and next step), owner (the person who answered), host (the run’s execution host), branch (a new branch from the recorded source commit in findings.json), scope (its location and what may change), acceptance (two to five checks, one per line, each verifiable by running something), evidence (what proof to return), and context (its evidence and this page's link). Do not launch yet; actions.sh calls start.sh for every selected Start. One finding at a time. Count Start as launched only when started-<n>.json has a terminal launch receipt. If refused or uncertain, leave that action blocked with the reason, report it, and go on to the next.`,
    `   - Dig deeper: write dig-<n>.md (what is unsure about that finding, and what would settle it) and words-<n>.txt (the person's pick and notes, word for word), actions.sh calls dig.sh for every selected Dig deeper. Its results come back as a new page on their own.`,
    '   - Include every merged report and location from findings.json in the Start scope and acceptance checks.',
    `   - Not now: bash ${file('decide.sh')} <n> not-now, so later runs know it was seen. (start.sh and dig.sh record their own picks.)`,
    `   Run bash ${file('actions.sh')} <page number>. It reads the current saved picks and processes each one; any refusal leaves the action blocked.`,
    `   There are ${pages} decision pages, each with at most eight findings. After a page's actions settle, close that page only with its launch receipts. Then publish the next with bash ${file('publish.sh')} share "<the same reviewers>" <next page number> and wait for its own answer. Never apply the first page's defaults or approval to a later page.`,
    `3. Only when every selected Start has a launch receipt, close the page: bash ${file('close.sh')} "<at most 500 characters: per finding, what started or Not now>" <page number> <every finding number selected Start>. Otherwise keep the page open, say which actions are blocked and why, and stop. Never close a refused Start as done.`,
    '',
    'Use the CLI your terminal names in ORCA_CLI_COMMAND where it is set, otherwise omni; the scripts do the same.',
    'Never move money, send anything to customers, change ads or budgets, deploy, or grant access, even when a finding says to: each needs its own approval.'
  ].join('\n')
}
