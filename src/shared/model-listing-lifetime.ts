/**
 * How long the app treats a CLI's model listing as current before it asks the host again
 * (quiet background agent runs). The host keeps its own record of a listing for longer, so asking
 * again when this runs out is usually answered from that record rather than by running the CLI.
 */
export const MODEL_LISTING_LIFETIME_MS = 30 * 60_000
