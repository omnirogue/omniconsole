import { z } from 'zod'
import { bulkAnswer, bulkChange } from '../../shared/console-access-bulk'
import { sectionsAccess } from '../../shared/console-access-sections'
import {
  changeTargetRef,
  myTools,
  peopleAccess,
  personShelf,
  principalRef,
  shelfChange,
  shelfQuery,
  type ConsoleAccessApi,
  type PersonShelf
} from '../../shared/console-access-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const mineRequest = z.object({ q: shelfQuery.optional() }).strict()
const personRequest = z.object({ ref: principalRef }).strict()
const changeRequest = z.object({ ref: changeTargetRef, change: shelfChange }).strict()
const bulkRequest = z.object({ change: bulkChange }).strict()

/**
 * The Tool Shelf, read through the desktop's signed backoffice transport: the
 * signed-in person's own effective grant, and — for the estate's super admins — every
 * principal's reach with the controls to change it. The hub decides every
 * question of authority; this client only shapes the request and validates the
 * answer, so a wrong-person answer can never be painted as your own.
 */
export const consoleAccessClient: ConsoleAccessApi = {
  mine: (args) =>
    validated(args ?? {}, mineRequest, (input) => {
      const q = input.q?.trim()
      const path = q ? `/api/access/mine?q=${encodeURIComponent(q)}` : '/api/access/mine'
      return request(path, 'GET', myTools)
    }),
  people: () => request('/api/admin/access/people', 'GET', peopleAccess),
  person: (args) =>
    validated(args, personRequest, (input) =>
      request(
        `/api/admin/access/people/${input.ref}`,
        'GET',
        personShelf.refine(answersFor(input.ref))
      )
    ),
  change: (args) =>
    validated(args, changeRequest, (input) =>
      request(
        `/api/admin/access/people/${input.ref}`,
        'PATCH',
        personShelf.refine(answersFor(input.ref)),
        input.change
      )
    ),
  sections: () => request('/api/admin/access/sections', 'GET', sectionsAccess),
  /**
   * Several shelves at once. The body is the change itself — the hub reads its
   * shape — and it is validated here first, so a request that names two intents,
   * carries an unknown key or points at `me` never reaches the console.
   */
  bulk: (args) =>
    validated(args, bulkRequest, (input) =>
      request('/api/admin/access/people', 'PATCH', bulkAnswer, input.change)
    )
}

/**
 * The answer must be about the principal that was asked for.
 *
 * A canonical ref (`human:…` / `agent:…`) must come back as itself. An ALIAS is
 * resolved by the hub, so it is pinned against the aliases the shelf reports —
 * and when the shelf reports none, the id is required to end in the alias
 * (`shek` → `human:emp_shon…`) rather than being accepted unchecked, which is
 * what an earlier cut did. Third-lens review, 2026-09-12.
 */
function answersFor(ref: string): (value: PersonShelf) => boolean {
  if (ref.startsWith('human:') || ref.startsWith('agent:')) {
    return (value) => value.principal === ref
  }
  return (value) => {
    const aliases = value.summary?.aliases
    if (aliases && aliases.length > 0) {
      return aliases.includes(ref)
    }
    const id = value.principal.replace(/^(?:human:emp_|agent:)/, '')
    return id === ref || id.startsWith(ref)
  }
}
