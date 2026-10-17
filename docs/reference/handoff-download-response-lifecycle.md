# Handoff download response lifecycle

Exact handoff downloads use Node's global fetch in the existing authenticated
Console transport. Every received response is consumed by the bounded reader or
cancelled through `cancelUnreadResponseBody` in `finally`, including HTTP errors,
size failures and account changes. Cancellation errors retain the original result.

This cleanup prevents unread response bodies from leaving Node's HTTP parser
paused after a rejected download. The call-site audit records the downloader only
after the cleanup is in place. Regression tests use real response streams to
verify cancellation and successful consumption; exact hash/size verification and
the 10 MB limit remain unchanged.
