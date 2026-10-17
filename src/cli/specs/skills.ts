import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'installed'],
    summary: 'List installed skill selectors',
    usage: 'omni skills installed [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists discovery IDs and names without reading skill contents into the CLI.',
      'Package metadata is validated when the selected skills are shared.',
      'Use an exact ID or an unambiguous name with `omni skills share --skill <selector>`.'
    ]
  },
  {
    path: ['skills', 'share'],
    summary: 'Publish explicitly selected installed skills behind one unlisted link',
    usage:
      'omni skills share --skill <selector> [--skill <selector> ...] --bundle-name <name> ' +
      '[--release-notes <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'bundle-name', 'release-notes'],
    notes: [
      'Requires the default-off permission in Settings → Share Skills.',
      'The bundle name may be human-readable; OmniConsole converts it to a portable lowercase package name.',
      'Selectors are exact discovery IDs or unambiguous names from `omni skills installed`.',
      'Only discovered skill directories can be selected; arbitrary paths and --all are not supported.',
      'The resulting link is unlisted. Anyone with it can inspect and install the bundle.'
    ],
    examples: [
      'omni skills share --skill frontend --bundle-name "Frontend Skills"',
      'omni skills share --skill frontend --skill testing --bundle-name "Team Toolkit" --json'
    ]
  },
  {
    path: ['skills', 'list'],
    summary: 'List version-matched skill guides bundled with this OmniConsole CLI',
    usage: 'omni skills list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Reads bundled guide metadata locally without contacting the OmniConsole runtime.',
      'With --json, prints a topics array of canonical names and one-line descriptions.',
      'Use `omni skills get <name>` for the full guide, or `omni skills install` to install skills.'
    ]
  },
  {
    path: ['skills', 'get'],
    aliases: [['skills', 'show']],
    summary: 'Print a version-matched skill guide as Markdown',
    usage: 'omni skills get <topic> [--full] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'topic', 'full'],
    positionalArgs: ['topic'],
    notes: [
      'Reads bundled guide content locally without contacting the OmniConsole runtime.',
      'Use --full to include bundled reference documents when the guide provides them.',
      'Use --json for a deterministic object containing canonical topic metadata and content.'
    ],
    examples: ['omni skills get omni-cli', 'omni skills get orchestration --full']
  },
  {
    path: ['skills', 'install'],
    summary: 'Install bundled OmniConsole skills via the community skills CLI',
    usage:
      'omni skills install [--skill <name>]... [--all] [--agent <name>[,<name>]] ' +
      '[--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the OmniConsole runtime.',
      'Resolves to the same `npx skills add <repo> --skill <name> ...` command used by ' +
        'OmniConsole Settings, plus the non-interactive flags an unattended host needs ' +
        '(`npx --yes` and `-y`), then runs it and forwards its output and exit code.',
      'Installs globally (all projects, adds --global) by default. Use --local to install ' +
        'into the current project instead.',
      'Targets the coding agents OmniConsole detects on this host, plus the shared ' +
        '.agents/skills directory. Without an explicit target the skills CLI installs ' +
        'into every agent it knows about, which litters a host with config ' +
        'directories for agents it does not have.',
      'Use --agent <name>[,<name>...] to choose targets yourself, or --agent universal ' +
        'for the shared directory alone. Required when OmniConsole detects no agent.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real install streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list installable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the install command from.'
    ],
    examples: [
      'omni skills install',
      'omni skills install --skill omni-cli --skill orchestration',
      'omni skills install --skill omni-cli --local',
      'omni skills install --skill omni-cli --agent claude-code,codex',
      'omni skills install --all --dry-run'
    ]
  },
  {
    path: ['skills', 'update'],
    summary: 'Refresh OmniConsole skills from the installed app bundle',
    usage: 'omni skills update [--skill <name>]... [--all] [--agent <name>[,<name>...]] [--local] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'skill', 'all', 'agent', 'local', 'dry-run'],
    notes: [
      'Reads the bundled skill registry locally without contacting the OmniConsole runtime.',
      'Refreshes from the same bundled source as install, using `npx skills add`. ' +
        'Bundled local installs are not registered with `npx skills update`.',
      'Updates the global install (all projects, adds --global) by default. Use --local to ' +
        'update the current project instead.',
      'Targets detected agents plus the shared skills directory. Use --agent <name>[,<name>...] ' +
        'to select targets explicitly. Existing installs at those targets are refreshed.',
      'Use --dry-run to print the resolved command without running it.',
      'With --json, the skill listing and --dry-run emit JSON; a real update streams ' +
        "npx's own non-JSON output live and rejects --json.",
      'Omit --skill and --all to list updatable skill names.',
      'Intended for headless hosts (SSH, containers, CI) with no desktop Settings UI to copy the update command from.'
    ],
    examples: [
      'omni skills update',
      'omni skills update --skill omni-cli --skill orchestration',
      'omni skills update --skill omni-cli --local',
      'omni skills update --all --dry-run'
    ]
  }
]
