import type { SessionChain } from '../../../shared/session-chain-types'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { companySlug } from '../../../shared/company-identity'
import { resolveCompanyFolder, resolveDomainFolder } from '../../../shared/company-folders'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type {
  WorkFolderCompany,
  WorkFolderDomain
} from '../../../shared/console-work-folders-contract'
import {
  conversationState,
  conversationStateRank,
  type ConversationState
} from './conversation-state'
import type { SidebarSession } from './sidebar-sessions'

export type CompanyTreeConversation = {
  session: SidebarSession
  /** The agent's own state, for the row glyph; the read-through is `state`. */
  dotState: AgentDotState | null
  state: ConversationState
  attention: AttentionPane | null
  waitingUntil: string | null
}

export type CompanyTreeDomain = {
  key: string
  id: string | null
  name: string
  folder: string
  conversations: CompanyTreeConversation[]
  needsYou: number
  working: number
}

export type CompanyTreeCompany = {
  key: string
  id: string | null
  slug: string
  name: string
  folder: string
  domains: CompanyTreeDomain[]
  /** Conversations inside the company folder but not inside any domain folder. */
  conversations: CompanyTreeConversation[]
  needsYou: number
  working: number
}

export type CompanyTree = {
  companies: CompanyTreeCompany[]
  /** Conversations that live outside every company folder. */
  unfiled: CompanyTreeConversation[]
  /** Conversations asked to wait: out of every list above until they return. */
  waiting: CompanyTreeConversation[]
}

export type CompanyTreeInput = {
  /** Defaults to the current clock; passed in so a run's phase can be read at a fixed time. */
  now?: number
  chainByRowKey?: ReadonlyMap<string, SessionChain>
  companies: readonly WorkFolderCompany[]
  sessions: readonly SidebarSession[]
  /** Workspace path by worktree id; a session with no known path stays unfiled. */
  pathByWorktreeId: ReadonlyMap<string, string>
  stateByPaneKey: ReadonlyMap<string, AgentDotState>
  attentionByPaneKey: ReadonlyMap<string, AttentionPane>
  waitingUntilByPaneKey: ReadonlyMap<string, string>
  home: string
  workRoot: string | null | undefined
  overrides: Record<string, string> | null | undefined
}

export function companyTreeKey(slug: string): string {
  return `company:${slug}`
}

export function domainTreeKey(slug: string, domain: Pick<WorkFolderDomain, 'id' | 'name'>): string {
  return `domain:${slug}/${domain.id ?? domain.name ?? ''}`
}

function toConversation(session: SidebarSession, input: CompanyTreeInput): CompanyTreeConversation {
  const paneKey = session.paneKey ?? ''
  const listed = input.attentionByPaneKey.get(paneKey) ?? null
  const chain = input.chainByRowKey?.get(session.rowKey)
  const plan = Boolean(chain?.outcomeSet) && chain?.state !== 'cancelled'
  // Why: a run's request counts once, on the conversation that owns the run, never on a worker's
  // row; and a plan's own pane that merely stopped is nobody's question.
  const attention = listed?.run
    ? listed.run.sourceRowKey === session.rowKey
      ? listed
      : null
    : plan
      ? null
      : listed
  const waitingUntil = input.waitingUntilByPaneKey.get(paneKey) ?? null
  return {
    session,
    dotState: input.stateByPaneKey.get(paneKey) ?? null,
    attention: waitingUntil ? null : attention,
    waitingUntil,
    state: conversationState({
      chain,
      state: input.stateByPaneKey.get(paneKey) ?? null,
      needsYou: attention !== null,
      waiting: waitingUntil !== null,
      now: input.now
    })
  }
}

function byAttention(a: CompanyTreeConversation, b: CompanyTreeConversation): number {
  return (
    conversationStateRank(a.state) - conversationStateRank(b.state) ||
    a.session.label.localeCompare(b.session.label)
  )
}

function count(list: readonly CompanyTreeConversation[], state: ConversationState): number {
  return list.filter(
    (row) => row.state === state || (state === 'working' && row.state === 'running')
  ).length
}

/**
 * The console's folder tree, read the way the desktop needs it: every company work
 * is filed under, its departments, and the conversations running inside each one's
 * folder — filed by where the conversation actually lives on disk, in the order the
 * hub gives, with what needs a person first. Waiting conversations stay out of the
 * counts; they come back on their own.
 */
export function buildCompanyTree(input: CompanyTreeInput): CompanyTree {
  const all = input.sessions.map((session) => toConversation(session, input))
  const waiting = all.filter((row) => row.state === 'waiting')
  const rows = all.filter((row) => row.state !== 'waiting')
  const placed = new Set<CompanyTreeConversation>()
  const companies: CompanyTreeCompany[] = []
  for (const company of input.companies) {
    const slug = companySlug(company.slug ?? company.name ?? company.id ?? '')
    if (!slug) {
      continue
    }
    const identity = { slug, name: company.name ?? slug }
    const folder = resolveCompanyFolder({
      workRoot: input.workRoot,
      overrides: input.overrides,
      company: identity,
      home: input.home
    })
    const domains: CompanyTreeDomain[] = company.domains
      .filter((domain) => (domain.name ?? '').trim().length > 0)
      .map((domain) => ({
        key: domainTreeKey(slug, domain),
        id: domain.id ?? null,
        name: domain.name!.trim(),
        folder: resolveDomainFolder(folder, domain.name!.trim()),
        conversations: [],
        needsYou: 0,
        working: 0
      }))
    const own: CompanyTreeConversation[] = []
    for (const row of rows) {
      if (placed.has(row)) {
        continue
      }
      const path = input.pathByWorktreeId.get(row.session.worktreeId)
      if (!path || !isPathInsideOrEqual(folder, path)) {
        continue
      }
      // Why: the deepest matching department wins; a session in the company root stays at the company.
      const domain = domains
        .filter((candidate) => isPathInsideOrEqual(candidate.folder, path))
        .sort((a, b) => b.folder.length - a.folder.length)[0]
      ;(domain ? domain.conversations : own).push(row)
      placed.add(row)
    }
    for (const domain of domains) {
      domain.conversations.sort(byAttention)
      domain.needsYou = count(domain.conversations, 'needs-you')
      domain.working = count(domain.conversations, 'working')
    }
    own.sort(byAttention)
    const all = [...own, ...domains.flatMap((domain) => domain.conversations)]
    companies.push({
      key: companyTreeKey(slug),
      id: company.id ?? null,
      slug,
      name: identity.name,
      folder,
      domains,
      conversations: own,
      needsYou: count(all, 'needs-you'),
      working: count(all, 'working')
    })
  }
  const unfiled = rows.filter((row) => !placed.has(row)).sort(byAttention)
  return { companies, unfiled, waiting }
}
