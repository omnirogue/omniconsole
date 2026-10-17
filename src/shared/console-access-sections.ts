import { z } from 'zod'
import {
  catalogueCapability,
  nullableText,
  sectionKey,
  sectionRef
} from './console-access-primitives'

/**
 * Sections: the estate's tools grouped the way a person thinks about them
 * (Advertising, Finance, Servers…). The grouping is DERIVED by the hub from the
 * connector id and the registry group — never typed by hand here — so the
 * desktop only ever reads it, and a connector the hub has not classified still
 * arrives, in "Other". Nothing is ever dropped (CONTRACT §A).
 *
 * `read_ref` / `write_ref` are the patterns a change names: one row on a shelf
 * can stand for a whole column of the matrix.
 */

/** A section as GET /api/admin/access/sections lists it, capabilities and all. */
export const accessSection = z
  .object({
    key: sectionKey,
    label: z.string(),
    groups: z.array(z.string()).default([]),
    read_ref: sectionRef,
    write_ref: sectionRef,
    read_count: z.number(),
    write_count: z.number(),
    /** Capabilities the estate floor keeps from everyone: in neither ref. */
    floor_count: z.number().default(0),
    capabilities: z.array(catalogueCapability).default([])
  })
  .passthrough()
export type AccessSection = z.infer<typeof accessSection>

/** The same section without its capability list, as GET /people carries it. */
export const accessSectionSummary = accessSection
  .omit({ capabilities: true })
  .extend({ capabilities: z.array(catalogueCapability).optional() })
export type AccessSectionSummary = z.infer<typeof accessSectionSummary>

/** A named shelf shape a super admin can apply to several people at once. */
export const accessTemplate = z
  .object({
    label: nullableText,
    sections: z.array(z.string()).default([])
  })
  .passthrough()
export type AccessTemplate = z.infer<typeof accessTemplate>

export const accessTemplates = z.record(z.string(), accessTemplate)
export type AccessTemplates = z.infer<typeof accessTemplates>

/** GET /api/admin/access/sections — the columns of the matrix, and the templates. */
export const sectionsAccess = z
  .object({
    schema_version: z.number().nullable().optional(),
    digest: z.string(),
    sections: z.array(accessSection).default([]),
    templates: accessTemplates.default({})
  })
  .passthrough()
export type SectionsAccess = z.infer<typeof sectionsAccess>

const sectionSide = z
  .object({
    granted: z.number().default(0),
    total: z.number().default(0),
    floor: z.number().optional()
  })
  .passthrough()

/**
 * One cell pair of the matrix for one principal: how much of a section's reads and
 * writes their EFFECTIVE grant carries (policy + overrides + floor), as the hub
 * resolves it. The desktop never recomputes this; it only renders it.
 */
export const principalSectionState = z
  .object({
    read: sectionSide.default({ granted: 0, total: 0 }),
    write: sectionSide.default({ granted: 0, total: 0 })
  })
  .passthrough()
export type PrincipalSectionState = z.infer<typeof principalSectionState>

export const principalSections = z.record(z.string(), principalSectionState)
export type PrincipalSections = z.infer<typeof principalSections>
