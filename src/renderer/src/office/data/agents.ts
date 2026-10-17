// @ts-nocheck
import { USER_COLOR } from '../theme/brand'
import { translate } from '@/i18n/i18n'

export const USER_ID = 'user'
export const USER_NAME = 'Operator'
// The office has desks/POIs sized for a small team; keep the fleet mapped to a
// bounded, representative set of characters (one per agent-type) — never 1 per
// live session — so the sim stays at 60fps.
// Seats in the room. The console capped this at 5 because it drew one character
// per agent TYPE; here the office seats one per open workspace, so it needs a
// real working set. Characters beyond the model's desks spawn on open floor.
export const MAX_AGENTS = 13
export { USER_COLOR }
export const DEFAULT_AGENTIC_SET_ID = 'omni-fleet'

export type AgentNode = {
  id: string
  index: number
  name: string
  description: string
  color: string
  model: string
  humanInTheLoop?: boolean
  position?: { x: number; y: number }
  subagents?: AgentNode[]
}

export type OutputType = 'text' | 'image' | 'music' | 'video'
export type AgenticSystem = {
  id: string
  teamName: string
  teamType: string
  teamDescription: string
  color: string
  outputType: OutputType
  outputModel: string
  outputAutoApprove?: boolean
  user: {
    index: number
    model: string
    position?: { x: number; y: number }
  }
  leadAgent: AgentNode
}

// ── Fleet roles → office characters ──────────────────────────────────────────
// Our real fleet has many machines and sessions, but only a few agent *types*.
// We map each agent-type to one character (like the-delegation's Creative
// Director / Developer / Designer / Copywriter). Live sessions are assigned to
// the character that owns their agent_name; a character "works" whenever any of
// its sessions is running. The dispatcher/orchestrator is the Lead Agent.
export const DISPATCHER_INDEX = 1
export const CLAUDE_INDEX = 2
export const CODEX_INDEX = 3
export const GROK_INDEX = 4

/** Map a session's agent_name / role to one of the fleet characters. */
export function fleetAgentIndex(agentName?: string | null, role?: string | null): number {
  const n = `${agentName ?? ''} ${role ?? ''}`.toLowerCase()
  if (n.includes('codex') || n.includes('gpt') || n.includes('openai')) {
    return CODEX_INDEX
  }
  if (n.includes('grok') || n.includes('xai')) {
    return GROK_INDEX
  }
  if (
    n.includes('claude') ||
    n.includes('anthropic') ||
    n.includes('opus') ||
    n.includes('sonnet') ||
    n.includes('haiku')
  ) {
    return CLAUDE_INDEX
  }
  if (
    n.includes('dispatch') ||
    n.includes('runner') ||
    n.includes('lead') ||
    n.includes('orchestr')
  ) {
    return DISPATCHER_INDEX
  }
  // Unknown agent-types fall to the dispatcher (the orchestrator seat).
  return DISPATCHER_INDEX
}

export const AGENTIC_SETS: AgenticSystem[] = [
  {
    id: 'omni-fleet',
    teamName: 'Omni Fleet',
    teamType: 'Live Operations',
    teamDescription:
      'The Omni Console fleet — dispatcher + Claude/Codex/Grok runners, driven by real sessions, dispatch load and provider usage.',
    color: '#6366F1',
    outputType: 'text',
    outputModel: 'fleet',
    outputAutoApprove: true,
    user: { index: 0, model: 'Operator', position: { x: 0, y: 0 } },
    leadAgent: {
      id: 'omni-dispatcher',
      index: DISPATCHER_INDEX,
      name: 'Dispatcher',
      get description() {
        return translate(
          'office.schema.agents.dispatcher_description',
          'Orchestrates the fleet: claims work, assigns runners, tracks load and reliability.'
        )
      },
      color: '#6366F1',
      model: 'Dispatcher',
      humanInTheLoop: true,
      position: { x: 0, y: 130 },
      subagents: [
        {
          id: 'omni-claude',
          index: CLAUDE_INDEX,
          name: 'Claude',
          get description() {
            return translate(
              'office.schema.agents.claude_description',
              'Anthropic Claude sessions (Opus / Sonnet / Haiku).'
            )
          },
          color: '#D97757',
          model: 'Claude',
          position: { x: -300, y: 280 }
        },
        {
          id: 'omni-codex',
          index: CODEX_INDEX,
          name: 'Codex',
          get description() {
            return translate(
              'office.schema.agents.codex_description',
              'OpenAI Codex / GPT sessions.'
            )
          },
          color: '#10A37F',
          model: 'Codex',
          position: { x: 0, y: 280 }
        },
        {
          id: 'omni-grok',
          index: GROK_INDEX,
          name: 'Grok',
          get description() {
            return translate('office.schema.agents.grok_description', 'xAI Grok sessions.')
          },
          color: '#64748B',
          model: 'Grok',
          position: { x: 300, y: 280 }
        }
      ]
    }
  }
]

export function getAgentSet(id: string, customSystems: AgenticSystem[] = []): AgenticSystem {
  return (
    customSystems.find((s) => s.id === id) ||
    AGENTIC_SETS.find((s) => s.id === id) ||
    AGENTIC_SETS[0]
  )
}

export function getAllAgents(system: AgenticSystem): AgentNode[] {
  const agents: AgentNode[] = []
  const traverse = (node: AgentNode) => {
    agents.push(node)
    if (node.subagents) {
      node.subagents.forEach(traverse)
    }
  }
  traverse(system.leadAgent)
  return agents
}

export function getAllCharacters(system: AgenticSystem): AgentNode[] {
  const userNode: AgentNode = {
    id: USER_ID,
    index: system.user.index,
    name: USER_NAME,
    color: USER_COLOR,
    model: system.user.model,
    description: translate(
      'office.schema.agents.operator_description',
      'Human operator watching the fleet.'
    )
  }
  return [userNode, ...getAllAgents(system)]
}
