import {
  WORKFLOW_CHECK_DEFAULT_SECONDS,
  WORKFLOW_CHECK_MAX_CASE_CHARS,
  WORKFLOW_CHECK_MAX_CASES,
  WORKFLOW_CHECK_MAX_PROTECT,
  WORKFLOW_CHECK_MAX_PROTECT_CHARS,
  WORKFLOW_CHECK_MAX_SECONDS,
  WORKFLOW_CHECK_MIN_SECONDS,
  WORKFLOW_MAX_CHECK_CHARS,
  type WorkflowCheck
} from './workflow-graph'
import { clampInt } from './workflow-spec-coercion'

const oneLine = (value: string, max: number) =>
  value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)

const lines = (raw: unknown, max: number, count: number): string[] =>
  Array.isArray(raw)
    ? raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => oneLine(entry, max))
        .filter(Boolean)
        .slice(0, count)
    : []

/** Practice cases, a time limit and predictions: only Improve's check has them, and only when set. */
function practiceFields(
  record: Record<string, unknown> | undefined
): Pick<WorkflowCheck, 'cases' | 'timeoutSeconds' | 'predict'> {
  const cases = lines(record?.cases, WORKFLOW_CHECK_MAX_CASE_CHARS, WORKFLOW_CHECK_MAX_CASES)
  return {
    ...(cases.length ? { cases } : {}),
    ...(record?.predict === true ? { predict: true as const } : {}),
    ...(typeof record?.timeoutSeconds === 'number'
      ? {
          timeoutSeconds: clampInt(
            record.timeoutSeconds,
            WORKFLOW_CHECK_MIN_SECONDS,
            WORKFLOW_CHECK_MAX_SECONDS,
            WORKFLOW_CHECK_DEFAULT_SECONDS
          )
        }
      : {})
  }
}

/** A change to the code: getting a private copy ready and the protected paths exist only with it. */
function patchFields(
  record: Record<string, unknown> | undefined
): Pick<WorkflowCheck, 'apply' | 'prepare' | 'protect'> {
  if (record?.apply !== 'patch') {
    return {}
  }
  const prepare =
    typeof record.prepare === 'string' ? oneLine(record.prepare, WORKFLOW_MAX_CHECK_CHARS) : ''
  const protect = lines(
    record.protect,
    WORKFLOW_CHECK_MAX_PROTECT_CHARS,
    WORKFLOW_CHECK_MAX_PROTECT
  )
  return {
    apply: 'patch',
    ...(prepare ? { prepare } : {}),
    ...(protect.length ? { protect } : {})
  }
}

/** The final test, kept back: kept only when it has a command or a case. */
function sealedFields(record: Record<string, unknown> | undefined): Pick<WorkflowCheck, 'sealed'> {
  const raw = record?.sealed as Record<string, unknown> | undefined
  const command =
    raw && typeof raw.command === 'string' ? oneLine(raw.command, WORKFLOW_MAX_CHECK_CHARS) : ''
  const cases = lines(raw?.cases, WORKFLOW_CHECK_MAX_CASE_CHARS, WORKFLOW_CHECK_MAX_CASES)
  return command || cases.length
    ? { sealed: { ...(command ? { command } : {}), ...(cases.length ? { cases } : {}) } }
    : {}
}

/** A person's objective check as saved: the command exactly as typed, one line. */
export function normalizeWorkflowCheck(raw: unknown, practice = false): { check?: WorkflowCheck } {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  // Exactly as typed, spaces inside quotes included: this is a command line, not prose.
  const command =
    typeof record?.command === 'string' ? oneLine(record.command, WORKFLOW_MAX_CHECK_CHARS) : ''
  return command
    ? {
        check: {
          command,
          ...(record?.stopWhenPassing === true ? { stopWhenPassing: true } : {}),
          ...(practice
            ? { ...practiceFields(record), ...patchFields(record), ...sealedFields(record) }
            : {})
        }
      }
    : {}
}
