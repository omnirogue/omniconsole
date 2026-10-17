import { z } from 'zod'

/**
 * The words every Tool Shelf shape is spelled with: what a capability looks like,
 * who a principal is, what may be named as the target of a change, and what a
 * section reference is.
 *
 * Its own module so the sections payload, the bulk request and the shelf contract
 * can each import the vocabulary without importing one another — a cycle between
 * three zod modules is an initialisation order bug waiting for the first import
 * that happens to run the wrong way round.
 */

export const nullableText = z.string().nullable().optional()
export const nullableBool = z.boolean().nullable().optional()

export const accessCapability = z
  .object({
    id: z.string(),
    label: nullableText,
    connector: nullableText,
    group: nullableText,
    action_class: nullableText,
    read_only: nullableBool,
    callable_now: nullableBool,
    requires_approval: nullableBool,
    approver: nullableText,
    company: nullableText,
    environment: nullableText,
    hint: nullableText
  })
  .passthrough()
export type AccessCapability = z.infer<typeof accessCapability>

/** The same capability, plus whether the estate floor puts it out of everyone's reach. */
export const catalogueCapability = accessCapability.extend({ hard_denied: nullableBool })
export type CatalogueCapability = z.infer<typeof catalogueCapability>

/** A principal as the hub spells it — or a person's alias, which the hub resolves. */
export const principalRef = z
  .string()
  .regex(/^(?:human:emp_[a-z0-9_-]{1,64}|agent:[a-z0-9][a-z0-9_-]{0,63}|[a-z0-9][a-z0-9_-]{0,63})$/)

/**
 * The target of a CHANGE. `me` is a valid ref to read (your own shelf) but never
 * to change: a super admin edits a named principal, and the BFF refuses `me`
 * anyway. Refusing it here keeps the promise that a malformed change never
 * leaves the app. Third-lens review, 2026-09-12.
 */
export const changeTargetRef = principalRef.refine((value) => value !== 'me', {
  message: 'name the principal whose access changes, not me'
})

/** A derived section: never typed by a person, always `section_of(connector, group)`. */
export const sectionKey = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)
export const SECTION_REF_RE = /^@section:[a-z][a-z0-9-]{1,40}:(?:read|write)$/
export const sectionRef = z.string().regex(SECTION_REF_RE)
export type SectionAccess = 'read' | 'write'

/**
 * What may be named as the target of a grant or a deny: one capability id, a
 * connector glob, or a section reference. The three forms every Tool Shelf
 * surface accepts (CONTRACT §A) — and nothing else, so a path, a bare word or a
 * smuggled newline never leaves the desktop.
 */
export const capabilityPattern = z
  .string()
  .regex(
    /^(?:@section:[a-z][a-z0-9-]{1,40}:(?:read|write)|[a-z0-9_*?[\]-]+(?:\.[a-z0-9_*?[\]-]+)+)$/
  )
export const overrideId = z.string().regex(/^apl_[A-Za-z0-9_-]{4,64}$/)
export const shelfDigest = z.string().regex(/^[a-f0-9]{8,64}$/)
/** One short line of text: no control characters, so a query can never smuggle a newline. */
export const shelfQuery = z.string().regex(/^[^\p{Cc}]{1,200}$/u)
/** Why the change was made. Recorded in the audit ledger, so it is never optional. */
export const shelfReason = z.string().trim().min(1).max(500)
/** An expiry is the hub's own string; it is never parsed here, only carried. */
export const shelfExpiry = z.string().max(40)
