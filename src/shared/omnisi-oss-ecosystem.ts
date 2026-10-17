import { OMNISI_MCP_NAME, OMNISI_MCP_URL } from './omni-console-mcp-ledger-headers'
import { OMNI_PROJECT_REPO, OMNI_PROJECT_REPO_URL } from './omni-project-repo'

/**
 * The OmniSI Open-Source Suite: the projects published under github.com/omnirogue that run
 * locally with your own model keys, and what connecting to OmniSI Cloud adds on top.
 */
export const OMNIROGUE_GITHUB_ORG_URL = 'https://github.com/omnirogue'

export const OMNISI_OSS_PROJECT_IDS = ['omniconsole', 'omniseek', 'omnievolve', 'jevlab'] as const
export type OmniSiOssProjectId = (typeof OMNISI_OSS_PROJECT_IDS)[number]

export type OmniSiOssProject = {
  readonly id: OmniSiOssProjectId
  readonly name: string
  /** `owner/repo` on GitHub. */
  readonly repository: string
  readonly repositoryUrl: string
  readonly summary: string
  /** Stdio MCP server executable on PATH; null when the project is not an MCP server. */
  readonly mcpCommand: string | null
  readonly cliCommand: string
  /** What the project does on its own, with no OmniSI account. */
  readonly localCapabilities: readonly string[]
}

export const OMNISI_OSS_SUITE = [
  {
    id: 'omniconsole',
    name: 'OmniConsole',
    repository: OMNI_PROJECT_REPO,
    repositoryUrl: OMNI_PROJECT_REPO_URL,
    summary: 'The open-source multi-agent super-intelligence desktop IDE.',
    mcpCommand: null,
    cliCommand: 'omni',
    localCapabilities: [
      'Parallel coding agents (Claude Code, Codex, Gemini, Grok and more) in isolated Git worktrees or folder workspaces',
      'Embedded terminals, browser, file explorer and diff review',
      'Local, SSH and WSL execution hosts',
      'The `omni` CLI for worktrees, terminals, sessions and the embedded browser'
    ]
  },
  {
    id: 'omniseek',
    name: 'OmniSeek',
    repository: 'omnirogue/omniseek',
    repositoryUrl: `${OMNIROGUE_GITHUB_ORG_URL}/omniseek`,
    summary: 'Multi-lens codebase discovery and deterministic citation-grounding verifier.',
    mcpCommand: 'omniseek-mcp',
    cliCommand: 'omniseek',
    localCapabilities: [
      'Multi-lens discovery across a local codebase',
      'Deterministic verification of the files and lines an answer cites'
    ]
  },
  {
    id: 'omnievolve',
    name: 'OmniEvolve',
    repository: 'omnirogue/omnievolve',
    repositoryUrl: `${OMNIROGUE_GITHUB_ORG_URL}/omnievolve`,
    summary: 'Evolutionary code and prompt optimization with a local SQLite lineage ledger.',
    mcpCommand: 'omnievolve-mcp',
    cliCommand: 'omnievolve',
    localCapabilities: [
      'Mutate-evaluate-select loops over code and prompts with your own evaluator',
      'Every candidate, score and parent recorded in a local SQLite lineage ledger'
    ]
  },
  {
    id: 'jevlab',
    name: 'JevLab',
    repository: 'omnirogue/jevlab',
    repositoryUrl: `${OMNIROGUE_GITHUB_ORG_URL}/jevlab`,
    summary:
      'LLM-as-judge calibration, bias diagnostics (swap and length bias) and agreement benchmarks.',
    mcpCommand: 'jevlab-mcp',
    cliCommand: 'jevlab',
    localCapabilities: [
      'Calibrate an LLM judge against labelled examples',
      'Diagnose position-swap and length bias',
      'Benchmark judge agreement with humans and with other judges'
    ]
  }
] as const satisfies readonly OmniSiOssProject[]

export function getOmniSiOssProject(id: OmniSiOssProjectId): OmniSiOssProject {
  return OMNISI_OSS_SUITE.find((project) => project.id === id)!
}

/** A stdio entry in the `mcpServers` shape Claude Code, Cursor and Gemini CLI all read. */
export type OmniSiOssMcpServerEntry = { command: string; args: string[] }

/**
 * Local MCP servers for the suite, keyed by server name. They run on this machine with no
 * OmniSI account; a fresh object each call, so callers can merge it into their own config.
 */
export function getDefaultOmniSiOssMcpServers(): Record<string, OmniSiOssMcpServerEntry> {
  const servers: Record<string, OmniSiOssMcpServerEntry> = {}
  for (const project of OMNISI_OSS_SUITE) {
    if (project.mcpCommand) {
      servers[project.id] = { command: project.mcpCommand, args: [] }
    }
  }
  return servers
}

/** OmniSI Cloud: the hosted service behind the proprietary OmniRogue Rust Engine. */
export const OMNISI_CLOUD = {
  name: 'OmniSI Cloud',
  engine: 'OmniRogue Rust Engine (proprietary)',
  mcpServerName: OMNISI_MCP_NAME,
  mcpUrl: OMNISI_MCP_URL
} as const

export const OMNISI_CLOUD_CAPABILITY_IDS = [
  'engine-throughput',
  'pareto-novelty-evolve',
  'calibrated-jev-oracle',
  'team-rbac-fleet'
] as const
export type OmniSiCloudCapabilityId = (typeof OMNISI_CLOUD_CAPABILITY_IDS)[number]

export type OmniSiCloudUpgradeCapability = {
  readonly id: OmniSiCloudCapabilityId
  readonly title: string
  /** The open-source project this capability extends. */
  readonly extends: OmniSiOssProjectId
  /** What runs locally in the open-source suite. */
  readonly openSource: string
  /** What connecting to OmniSI Cloud adds. */
  readonly cloud: string
}

const CLOUD_UPGRADE_CAPABILITIES: readonly OmniSiCloudUpgradeCapability[] = [
  {
    id: 'engine-throughput',
    title: 'Hosted Rust engine throughput',
    extends: 'omniconsole',
    openSource: 'Agents, evaluations and MCP tools run on your own machine and SSH hosts.',
    cloud:
      'Large evaluation and generation batches run in parallel on the hosted OmniRogue Rust Engine.'
  },
  {
    id: 'pareto-novelty-evolve',
    title: 'Pareto and novelty Evolve',
    extends: 'omnievolve',
    openSource: 'Single-objective evolutionary search with a local SQLite lineage ledger.',
    cloud: 'Multi-objective Pareto fronts and novelty search across hosted populations.'
  },
  {
    id: 'calibrated-jev-oracle',
    title: 'Calibrated multi-family JEV oracle',
    extends: 'jevlab',
    openSource: 'Calibrate and debias the judges you run with your own keys.',
    cloud:
      'A judge ensemble spanning model families, calibrated and bias-checked as a hosted service.'
  },
  {
    id: 'team-rbac-fleet',
    title: 'Team RBAC and fleet',
    extends: 'omniconsole',
    openSource: 'One person, their own machines and their own provider accounts.',
    cloud: 'Shared workspaces with role-based access, audit and a managed execution fleet.'
  }
]

/** What OmniSI Cloud unlocks beyond the local suite, each tied to the project it extends. */
export function getOmniSiCloudUpgradeCapabilities(): readonly OmniSiCloudUpgradeCapability[] {
  return CLOUD_UPGRADE_CAPABILITIES
}
