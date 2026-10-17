import type {
  AccessOverride,
  AccessSectionSummary,
  PrincipalSummary,
  SectionAccess,
  ShelfChange
} from '../../../../shared/console-access-contract'

/**
 * What one cell of the people × sections matrix says, derived from the EFFECTIVE
 * state the hub reported — never recomputed from the policy here.
 *
 * Pure on purpose: a cell that says "on" when the person cannot use the tools, or
 * a click that sends a grant where a removal was meant, is the kind of mistake
 * that is only ever caught by a test, and a test needs this without a renderer.
 */

export type CellState = 'on' | 'off' | 'partial' | 'floor' | 'empty'

export type MatrixCell = {
  principal: string
  section: string
  access: SectionAccess
  ref: string
  state: CellState
  granted: number
  total: number
  floor: number
}

export function sectionRefFor(section: AccessSectionSummary, access: SectionAccess): string {
  return access === 'read' ? section.read_ref : section.write_ref
}

/**
 * `floor` counts capabilities the estate floor keeps from everyone. They are in
 * NEITHER ref, so a section whose writes are all floor has nothing to grant —
 * which is a different answer from "off", and must never look like one.
 */
export function cellState(granted: number, total: number, floor: number): CellState {
  if (total <= 0) {
    return floor > 0 ? 'floor' : 'empty'
  }
  if (granted <= 0) {
    return 'off'
  }
  return granted >= total ? 'on' : 'partial'
}

export function cellFor(
  principal: PrincipalSummary,
  section: AccessSectionSummary,
  access: SectionAccess
): MatrixCell {
  const state = principal.sections?.[section.key]?.[access]
  const granted = state?.granted ?? 0
  const total = state?.total ?? (access === 'read' ? section.read_count : section.write_count)
  const floor = (access === 'write' ? (state?.floor ?? section.floor_count) : 0) || 0
  return {
    principal: principal.principal,
    section: section.key,
    access,
    ref: sectionRefFor(section, access),
    state: cellState(granted, total, floor),
    granted,
    total,
    floor
  }
}

/** Humans first, then agent roles; each group by the name the hub spells. */
export function orderedPrincipals(principals: PrincipalSummary[]): PrincipalSummary[] {
  const rank = (row: PrincipalSummary): number => {
    if (row.kind === 'human' || row.principal.startsWith('human:')) {
      return 0
    }
    return 1
  }
  return [...principals].sort((a, b) => rank(a) - rank(b) || a.principal.localeCompare(b.principal))
}

/** The standing row that explains this cell, if one names exactly its section ref. */
export function overrideForRef(
  overrides: AccessOverride[] | undefined,
  ref: string
): AccessOverride | null {
  const rows = (overrides ?? []).filter((row) => row.capability === ref && row.expired !== true)
  return rows.at(-1) ?? null
}

export type CellIntent = { change: ShelfChange; turning: 'on' | 'off' }

/**
 * The one override row a click on this cell writes.
 *
 * Turning a cell OFF that is on only because of a standing GRANT withdraws that
 * row rather than stacking a deny on top of it — and the mirror for turning one
 * on. Otherwise the ledger fills with pairs that cancel out and nobody can read
 * who decided what. A partial cell is filled in, so clicking it grants.
 */
export function cellIntent(
  cell: MatrixCell,
  overrides: AccessOverride[] | undefined,
  digest: string,
  reason: string,
  expiresAt?: string
): CellIntent {
  return targetIntent(cell.ref, cell.state === 'on', overrides, digest, reason, expiresAt)
}

/**
 * The same rule for one capability id as for a whole section ref, so the drill-in
 * per-tool toggles and the matrix cells can never disagree about what a click means.
 */
export function targetIntent(
  target: string,
  isOn: boolean,
  overrides: AccessOverride[] | undefined,
  digest: string,
  reason: string,
  expiresAt?: string
): CellIntent {
  const existing = overrideForRef(overrides, target)
  const turning = isOn ? 'off' : 'on'
  if (turning === 'off') {
    if (existing?.action === 'grant') {
      return {
        turning,
        change: { op: 'remove', override_id: existing.id, expected_digest: digest }
      }
    }
    return {
      turning,
      change: { op: 'deny', capability: target, reason, expected_digest: digest }
    }
  }
  if (existing?.action === 'deny') {
    return { turning, change: { op: 'remove', override_id: existing.id, expected_digest: digest } }
  }
  return {
    turning,
    change: {
      op: 'grant',
      capability: target,
      reason,
      expected_digest: digest,
      ...(expiresAt ? { expires_at: expiresAt } : {})
    }
  }
}

/** True when a cell can be clicked at all: the estate floor is nobody's to lift. */
export function cellIsChangeable(cell: MatrixCell): boolean {
  return cell.state !== 'floor' && cell.state !== 'empty'
}
