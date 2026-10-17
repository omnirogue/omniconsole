# OMP model identity and execution-host discovery

The IDE probes `omp models ls --json` on the selected execution host through the
existing model-discovery runtime RPC. Native, WSL, SSH and paired-runtime scopes
retain separate caches. An unreachable host never falls back to the client.
OMP uses the existing `omp acp` recipe for structured Chat; this does not add
remote ACP support. SSH uses the existing PTY surface.

The CLI contract was inspected in the published `@oh-my-pi/pi-coding-agent@18.2.0`
package (`src/cli/models-cli.ts`, `src/config/model-resolver.ts`,
`src/modes/acp/acp-agent.ts`). The installed dispatcher CLI's help independently
confirmed this command. JSON rows contain `provider`, `id`, `selector`, `name`,
context/token limits, thinking, input modalities and costs. The selector is
`provider/id`; an OpenRouter example is `openrouter/moonshotai/kimi-k2.6`.
Provider namespaces and nested slashes/colon suffixes remain opaque in the
existing model string through options, outcomes, resume and fleet actor compilation.
Fleet actors are `omp:openrouter/moonshotai/kimi-k2.6`.

No static models or guessed CLI default are supplied. The CLI returns models
whose authentication is configured, not proof of successful authentication,
model availability, tool support or fleet readiness. Version 18.2 does not expose
`supportsTools` in this JSON. Explicit `supportsTools: false` from a future listing
is excluded; absent metadata remains unknown and must not be called tool-capable.
Credentials remain in the host's existing OMP auth/config or inherited proxy
environment. No credentials are transported in catalog data or copied by this feature.
An explicit model selection is retained when another host's catalog lacks it;
the launch must report an unavailable model rather than silently choose a default.

## Wire compatibility

No RPC method, opcode or required field is added. New clients use the existing
`git.discoverCommitMessageModels` request with `agentId: omp`; older hosts return
unsupported discovery and the client offers no invented catalog. Existing model
strings carry the entire selector. Old clients may ignore the catalog. The existing
ACP `session/set_config_option` carries the same full selector before the first
prompt, including on acquisition after restart.

## Fleet boundary and acceptance

This IDE catalog is not a fleet inventory. The current Console inventory and Hub
execution path do not admit OMP. The backend must explicitly offer execution-host
OMP routes, enforce the existing Grok/Gemini/Kimi OpenRouter candidate policy,
and retain requested and effective provider/model receipts before fleet support
can be accepted. Do not convert OMP to a different harness implicitly.

After a signed candidate and backend implementation are available:

1. On each native/SSH host, obtain its own catalog and select a current allowed
   fixed OpenRouter model. Run a prompt requiring an actual tool call. Record
   harness, host, requested selector, effective provider/model, provider session
   identity and tool result. A listing alone is not success.
2. Switch PTY Chat/Terminal, save an outcome, restart, and resume the same session.
   Verify the full selector and source evidence survive; inspect the launch argv
   and provider receipt without logging credentials. ACP has no PTY toggle.
3. Dispatch one fixed model and one explicitly ordered allowed fallback route.
   Check the reviewed graph, sealed admission, execution host, attempt receipts
   and actual tool result. Induce a first-candidate failure with an authorized
   test fixture; verify the effective fallback is allowed and differs from the
   failed first attempt. An upstream outage must remain a failure.
4. Reject an out-of-policy model, an unavailable host and a host lacking OMP.
   Confirm no default substitution, no duplicated workflow, and no credential
   data in errors or receipts.
