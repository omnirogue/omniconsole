import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKFLOW_RUN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['discover', 'deliver'],
    summary: 'Deliver one completed Discover run to OmniOS, without rerunning it',
    usage: 'omni discover deliver <run-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run-id'],
    positionalArgs: ['run-id'],
    examples: ['omni discover deliver 2f6a… --json'],
    notes: [
      'Uses this runtime’s durable delivery outbox. Delivery is published only when published.json contains a successful page receipt. A pending or unknown publishing session is never duplicated. Older runtimes refuse this new method; update the runtime to retry delivery.'
    ]
  },
  {
    path: ['workflow', 'run'],
    summary: 'Run a built-in workflow template headless through the app and follow it to the end',
    usage:
      'omni workflow run --template <discover|evolve> [--other --template <improve|find|decide|investigate|council|best-of-n|quick-discover>] (--prompt <text> | --prompt-file <file>) [--depth quick|thorough] [--focus-finding <run>:<n>] [--routes <claude,codex,…>] [--models <tier | step=models;…>] [--runs-on fleet|local] [--host <name> [--force-host <reason>]] [--requested-by <person> [--requested-by-id <emp_id>] --request <their words>] [--spec-file <override.json>] [--worktree <selector>] [--operation-id <uuid>] [--origin cli|benchmark] [--no-earlier-runs] [--no-follow] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'template',
      'other',
      'prompt',
      'prompt-file',
      'depth',
      'routes',
      'models',
      'runs-on',
      'host',
      'force-host',
      'requested-by',
      'requested-by-id',
      'request',
      'spec-file',
      'worktree',
      'operation-id',
      'origin',
      'no-earlier-runs',
      'focus-finding',
      'no-follow',
      'target',
      'spec-path',
      'checkout',
      'iterations',
      'patience',
      'seed-from',
      'rubric-from',
      'usd-cap',
      'submitted-by'
    ],
    positionalArgs: ['prompt'],
    examples: [
      'omni workflow run --template discover --prompt "Find correctness bugs in src/queue" --json',
      'omni workflow run --template quick-discover --prompt "Find correctness bugs" --json',
      'omni workflow run --template discover --depth quick --prompt "Find correctness bugs in src/queue" --json',
      'omni workflow run --template council --prompt-file question.md --routes claude,codex',
      'omni workflow run --template investigate --prompt "Did the queue rewrite drop any retry paths?" --json',
      'omni workflow run --template council --prompt "Which cache design?" --models cheap',
      'omni workflow run --template discover --prompt "Find correctness bugs" --models "*=cheap;find=claude:opus,codex,grok,openrouter:deepseek/deepseek-v4-flash,ollama:qwen3:8b;report=frontier"',
      'omni workflow run --template discover --prompt-file goal.md --spec-file arm-quick.json --json',
      'omni workflow run --template council --prompt "Which cache design?" --host mw0001 --json',
      'omni workflow run --template council --prompt-file q.md --requested-by "Sal" --request "run a council on the cache design on the fleet" --no-follow --json',
      'omni workflow run evolve --target email-smoke --iterations 3 --host mw0001 --json',
      'omni workflow run evolve --target email --seed-from email-replies --usd-cap 5 --requested-by "Sal" --request "evolve the email replier prompt on the fleet" --no-follow --json'
    ],
    notes: [
      '--focus-finding <run>:<n> digs into a finding from that completed Discover page in the same workspace. It seeds the brief and removes that title from the earlier-runs list; use --depth quick for one focused round.',
      'Keep --operation-id for retries: one request uses one workflow conversation and execution. Reusing it for different work is refused.',
      '--origin benchmark marks evaluation runs explicitly so they can be separated from ordinary conversations; it never changes execution permissions.',
      'discover and quick-discover show their finders up to 50 titles that the last 5 completed runs of the same template on the same workspace and context already reported, as "report only if materially new". --no-earlier-runs starts without that list; --origin benchmark runs never get it, and OMNI_WORKFLOW_EARLIER_RUNS=0 in the app\'s environment turns it off for every run.',
      'Opens the workflow conversation in the workspace (the current one by default), starts it as Start does, and follows it: progress goes to stderr, the report to stdout.',
      '--depth (discover only, refused for any other template): quick runs one Find and Verify round; thorough, the default, repeats them until nothing new turns up (at most two rounds). Without the flag the request carries no depth, so a runtime from before it still starts Discover.',
      '--routes limits the seats to these model families; every one named must be set up on this computer.',
      '--models chooses the models: a tier for every step (cheap, standard or frontier; the lineups are the ones under Adjust tiers in the app), or entries separated by ";", each <step>=<tier> or <step>=<model>,<model>,… with "*" for every step not named. A model is <route> (the family\'s default) or <route>:<model>, with a route of claude, codex, grok, gemini, openrouter (an API id, e.g. openrouter:deepseek/deepseek-v4-flash) or ollama (an installed tag, e.g. ollama:qwen3:8b). A list on a named step is a combo: the step runs exactly one agent per model, from any mix of providers. Only models change; steps that decide (review, rank, synthesize) refuse Google-family models.',
      '--runs-on fleet (the default) places the run on a registered worker with verified spare capacity and refuses by name when none has any; --runs-on local runs it on this computer. On another computer the seats and the Check run there over SSH on its own signed-in Claude and Codex; this computer keeps the run. See docs/reference/workflow-fleet-placement.md.',
      '--host <name> runs it on that fleet host (a heavy-work row of the estate hosts file): a fresh reading is taken and a host above 0.8 load per core is refused by name. --force-host <reason> overrides that bound for a person, never for an agent.',
      'From inside an agent session the command starts council, discover and evolve only, and only with --requested-by "<person>" and --request "<their words>"; both are frozen into the run and shown with it.',
      'omni workflow run evolve (or --template evolve) [--target email-smoke|email|ads | --spec-path <path>] [--checkout <path>] [--iterations <n>] [--seed-from <target>] [--rubric-from <sha256>] [--usd-cap <usd>] [--submitted-by <who>] takes no prompt; the placement, --requested-by/--request, --no-follow and --json flags work as for any template.',
      "evolve runs jev-lab's OpenEvolve CLI on the chosen host's Evolve checkout (--checkout, default ~/Repos/jev-lab-evolve; see docs/evolve-hosts.md in jev-lab): submit (freezes the spec in the central ledger), one detached worker, then status until the ledger run is done or failed. It needs Claude signed in on that host over SSH (the drafter is claude -p) and is refused by name otherwise. --target picks a built-in spec (email-smoke, the synthetic seat smoke, is the default); --spec-path names another spec in the checkout. --submitted-by defaults to the person, or to --requested-by for an agent. With --no-follow it returns once the ledger run id is known; the run keeps going on the host and in the app. omni workflow status evo_… reports it.",
      '--json prints the run id and the frozen placement (host, mode, load reading and when it was read); a refused Start prints its reason in the same document. omni workflow status <run-id> reports it later.',
      '--spec-file lays a JSON object over the template: top-level fields replace the template\'s, and "steps" either replaces every step (a list) or patches steps by id (an object).',
      'quick-discover: one call to the strongest seat (Claude Opus where set up) reads every source file of the workspace at once (.gitignore respected; vendored, build, lock and binary files left out) and lists what it finds, then a short call writes the report; every result stays unverified (tally "unverified", singlePass: true). For code that fits one context: a scope over 60% of the seat\'s context window is refused, never cut. For larger code, or when results must be checked independently, use discover.',
      'An agent may name its model in the spec file, e.g. {"steps":{"find":{"agents":[{"route":"claude","model":"claude-opus-5-5[1m]"}]}}} for the 1M-context Opus seat.',
      'Build + Review is not offered: it runs through its own executor, which this command does not start.',
      '--json prints the final markdown, the structured results (review targets with tally, severity, location and JEV score; standings; the Find trail; the loop), gaps, wall-clock time, and each call\'s duration and tokens. What the app did not record is "unknown", never 0; run tokens are "unknown" unless every call reported them (the known part is under usage.partialTokens).',
      'Ctrl-C stops following, not the run; --no-follow returns as soon as the run starts.'
    ]
  },
  {
    path: ['workflow', 'status'],
    summary:
      'Report a workflow run: its state, where it runs, who asked for it and each seat session',
    usage: 'omni workflow status <run-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run-id'],
    positionalArgs: ['run-id'],
    examples: ['omni workflow status 2f6a…', 'omni workflow status 2f6a… --json'],
    notes: [
      "Reads the run from this computer's records without resuming it: state, the frozen placement (host, mode, load reading), who asked an agent to start it and their words, and each launched attempt with the host it ran on, its folder there and the session it answered in.",
      'A run that reviews items one by one (Discover) also lists the findings verified so far: each one as soon as its last review confirms it, while the run goes on (--json: verified.count and verified.items).'
    ]
  }
]
