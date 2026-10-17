/**
 * Programs new admissions pin. Council 1-4 and Discover 1-5 are the frozen legacy programs;
 * Council 5 and Discover 6 are the working-agent programs, admitted only for working drafts and
 * run by the working execution service. Every other new Start pins these revisions.
 */
/** Karpathy llm-council (presets/council-v6.ts). */
export const COUNCIL_REVISION = 6 as const
/** Scout, find, verify and rank (presets/discover-v7.ts). */
export const DISCOVER_REVISION = 7 as const
/** The working-agent programs; their replay must stay byte-identical. */
export const WORKING_COUNCIL_REVISION = 5 as const
export const WORKING_DISCOVER_REVISION = 6 as const
/** The workflow graph interpreter (graph/graph-program.ts); every new run pins it. */
export const GRAPH_PROGRAM_REVISION = 1 as const
