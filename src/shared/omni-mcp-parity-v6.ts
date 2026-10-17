/**
 * Wire types for WorkOS org-shared MCP features as the OmniSI cloud sends them (shared_tools,
 * decisions, collect, study, relay). Field names follow the server's snake_case JSON; fields a
 * host may not send yet are optional (docs/reference/remote-wire-compatibility.md).
 */

/** WorkOS person id from the org's `people` table. */
export type PersonId = string
export type IsoTime = string

// --- Org-shared tool broker (tools_list / tools_call) ---
export const SHARED_TOOL_PROVIDERS = ['github', 'slack'] as const
export type SharedToolProvider = (typeof SHARED_TOOL_PROVIDERS)[number]
export type ToolAccess = 'read' | 'write'
export type BrokerOperation = { name: string; mode: ToolAccess; schema: Record<string, unknown> }

/** One `tools_list` row: the caller's own connection or one shared with them. */
export type BrokerConnection = {
  owner: PersonId
  provider: SharedToolProvider
  access: ToolAccess
  connected: boolean
  /** Write operations are listed only when `access` is `write`. */
  operations: BrokerOperation[]
}

export type BrokerShare = {
  share_id: string
  owner: PersonId
  provider: SharedToolProvider
  /** Null shares with the whole org. */
  shared_with: PersonId | null
  access: ToolAccess
  expires_at: IsoTime | null
  revoked_at?: IsoTime | null
}

export type BrokerCallRequest = {
  provider: SharedToolProvider
  owner: PersonId
  operation: string
  arguments: Record<string, unknown>
  /** Resumes a write after the owner's Decision. */
  decision_id?: string
}

/** Codes the IDE acts on; newer server codes still arrive as plain strings. */
export type BrokerErrorCode =
  | 'connection_not_shared'
  | 'connect_or_reauthorize'
  | 'owner_approval_required'
  | 'action_mismatch'
  | (string & {})

/** A write runs only after the owner's unconditional approval. */
export type BrokerCallResult =
  | { status: 'approval_required'; decision_id: string; url: string; expires_at: IsoTime }
  | { status: 'conditions_require_review'; decision_id: string; conditions: string }
  | { status: 'done'; result: unknown; warnings?: ['report_failed'] }
  | { error: BrokerErrorCode }

// --- RBAC policies ---
export type OrgRole = 'admin' | 'member'

/** Permissions by domain, in the order access matrices lay them out. */
export const RBAC_PERMISSION_GROUPS = {
  tools: ['read', 'write', 'share'],
  decisions: ['ask', 'answer'],
  surveys: ['create', 'respond'],
  comms: ['send'],
  handoffs: ['offer', 'accept'],
  rbac: ['manage']
} as const
type RbacGroups = typeof RBAC_PERMISSION_GROUPS
export type RbacGroup = keyof RbacGroups
export type RbacPermission = { [G in RbacGroup]: `${G}.${RbacGroups[G][number]}` }[RbacGroup]

export type RbacSubject =
  | { kind: 'person'; person_id: PersonId }
  | { kind: 'role'; role: OrgRole }
  | { kind: 'everyone' }

export type RbacRule = {
  rule_id: string
  subject: RbacSubject
  permissions: RbacPermission[]
  effect: 'allow' | 'deny'
  /** Narrows a `tools.*` rule to one provider. */
  provider?: SharedToolProvider
  expires_at?: IsoTime | null
}

export type RbacPolicy = {
  policy_id: string
  revision: number
  rules: RbacRule[]
  updated_at: IsoTime
  updated_by: PersonId
}

/** Deny beats allow; with no matching rule the role default decides. */
export type RbacVerdict = {
  allowed: boolean
  reason: 'role_default' | 'allow_rule' | 'deny_rule' | 'expired_rule' | 'not_team_member'
  rule_id?: string
}

// --- Decisions: 1-to-1 and 1-to-many ---
export type DecisionKind = 'approval' | 'choice' | 'question'
/** Only these answers approve an action. */
export type DecisionApproval = 'approve' | 'approve_with_conditions' | 'approve_with_edits'
type DecisionReply = 'change' | 'no' | 'dont_understand' | 'choice' | 'text'
export type DecisionAnswerType = DecisionApproval | DecisionReply
type DecisionEnded = 'expired' | 'cancelled' | 'superseded' | 'closed'
export type DecisionStatus = 'pending' | 'open' | 'answered' | 'auto_approved' | DecisionEnded

/** `one` asks a single person; `many` asks named people or the whole org and waits on a quorum. */
export type DecisionAudience =
  | { fan_out: 'one'; answerers: { people: [PersonId] } }
  | { fan_out: 'many'; answerers: { people: PersonId[] }; quorum: QuorumRule }
  | { fan_out: 'many'; everyone: true; quorum: QuorumRule }

export type DecisionAsk = DecisionAudience & {
  kind: DecisionKind
  title: string
  question: string
  why: string
  unknowns: string[]
  options?: string[]
  recommendation: { option: string; reason: string }
  risk?: 'low' | 'medium' | 'high' | 'critical'
  due_at?: IsoTime
}

export type DecisionAnswer = {
  type: DecisionAnswerType
  who: PersonId
  at: IsoTime
  choice?: string
  text?: string
  conditions?: string
  edits?: string
}

export type DecisionRecord = DecisionAsk & {
  decision_id: string
  revision: number
  status: DecisionStatus
  asked_by: { person: PersonId }
  /** Latest answer per person; at most one for `one`. */
  answers: DecisionAnswer[]
  progress?: QuorumProgress
}

// --- Quorum progress (collect.progress) ---
export type QuorumRule =
  | { kind: 'all' }
  | { kind: 'any' }
  | { kind: 'count'; min: number }
  | { kind: 'fraction'; ratio: number }

export type QuorumProgress = {
  submitted: number
  /** Null when the ask goes to everyone. */
  of: number | null
  everyone: boolean
  ready: boolean
  ready_at: IsoTime | null
  reason: 'due' | 'all' | 'quorum' | null
  overdue: boolean
  people: { person_id: PersonId; status: 'done' | 'not_started' }[]
  /** Responses the rule needs; absent on hosts that close only on `all` or `due`. */
  needed?: number
}

// --- Multi-person surveys (collect / study) ---
type SurveyQuestionBase = { id: string; prompt: string; required: boolean }
export type SurveyQuestion = SurveyQuestionBase &
  (
    | { kind: 'single_choice' | 'multi_choice'; options: string[] }
    | { kind: 'text'; max_length?: number }
    | { kind: 'scale'; min: number; max: number }
  )

export type SurveyAnswerValue =
  | { type: 'choice'; picks: string[] }
  | { type: 'text'; text: string }
  | { type: 'scale'; value: number }

export type Survey = {
  survey_id: string
  title: string
  asked_by: PersonId
  participants: PersonId[]
  everyone: boolean
  /** Blind studies never reveal who answered what. */
  blind: boolean
  questions: SurveyQuestion[]
  quorum: QuorumRule
  due_at: IsoTime
  status: 'open' | 'closed'
}

export type SurveyResponse = {
  survey_id: string
  person_id?: PersonId
  answers: Record<string, SurveyAnswerValue>
  submitted_at: IsoTime
}

/** Choice and scale answers are counted by option or value; text answers are listed. */
export type SurveyTally = { question_id: string; counts?: Record<string, number>; texts?: string[] }
export type SurveyResults = { survey_id: string; progress: QuorumProgress; tallies: SurveyTally[] }

// --- Peer comms (relay) and handoffs ---
/** Agent liveness uses the SSH execution-boundary vocabulary only. */
export type PeerPresence = 'live' | 'unverifiable' | 'exited'

/** An agent always acts for the person who owns its session; `host` is its execution host. */
export type PeerParty =
  | { kind: 'person'; person_id: PersonId }
  | { kind: 'agent'; session_id: string; owner: PersonId; host?: string; presence?: PeerPresence }

export type PeerMessage = {
  message_id: string
  thread_id: string
  from: PeerParty
  to: PeerParty[]
  kind: 'note' | 'ask' | 'reply' | 'status'
  body: string
  reply_to?: string
  sent_at: IsoTime
  delivery: 'queued' | 'delivered' | 'read' | 'failed'
}

export type Handoff = {
  handoff_id: string
  from: PeerParty
  to: PeerParty
  title: string
  summary: string
  artifacts: { label: string; path?: string; url?: string }[]
  open_questions: string[]
  decision_ids: string[]
  status: 'offered' | 'accepted' | 'declined' | 'withdrawn' | 'completed'
  created_at: IsoTime
  responded_at?: IsoTime
  note?: string
}
