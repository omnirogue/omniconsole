# Task continuation

Add Next on an existing task or task-bound handoff opens a continuation form.
The selected provider, model, effort, instruction, task and optional handoff remain
bound to the server-admitted job. The user chooses an existing workspace on the
execution host. The current implementation requires a local Mac with the native
process observer; unsupported hosts refuse before admission.

## Admission contract

Task-mode availability first negotiates the signed read
`GET /api/gtd/task-continuation/capabilities`, which returns
`{ok:true,task_continuation:{available:boolean,reason?:string}}`. Task-mode reads
include `?task_id=btk_...` so current ownership and task access determine
availability without assigning or reassigning the task. A missing method,
old server, unreadable response or disabled capability leaves task continuation
unavailable. Ordinary Start Work has its own availability. Main reads the
capability again under the captured person before every admission request; the
server enforces its rollback flag independently on the write itself.

`POST /api/gtd/workflow-tasks/{task_id}/continue` carries:

```json
{
  "operation_id": "retained-client-operation-id",
  "thread_id": "hth_optional",
  "goal_id": "cgl_explicitly_selected_if_missing",
  "provider": "codex",
  "model": "selected-model",
  "effort": "selected-effort",
  "instruction": "The exact instruction, preserving whitespace.",
  "workspace": { "kind": "folder", "path": "/actual/real/path", "host": "local" }
}
```

For Git, `workspace` instead has `kind: "git"`, the actual origin URL in `repo`,
and `base_branch` plus `base_sha` read from the selected worktree. The main process
rechecks this evidence before activation. Existing Foreman `owner/repo` handoff
slugs explicitly identify GitHub; host-qualified repository identities retain
their host.

The successful reply names `{ok:true,workflow_id,digest,job_id}`. The IDE reads
that job's existing handoff, verifies all immutable selections, and uses the
existing activation, worker preparation, held process, start receipt and release
sequence. A client task ID or a serialized gate is never launch authority.

A `task_setup_required` error may carry eligible goals for a task without an
outcome. The form requires explicit selection and retries the same operation ID.
The server checks the actual company/domain policy and fills only a missing goal;
the client neither infers a goal nor reparents an existing one.

## Files and results

The handoff's existing `workflow_inputs` object may carry additive `source_files`:
`handoff_file` entries pin the handoff version DTO, while `task_file` entries pin
task ID, relative path, SHA-256 and byte length. The IDE downloads under the same
captured person, verifies bytes, and retains private files outside the Git diff.
It passes their real paths and provenance into the worker's launch brief.

Folder jobs retain their actual report and observed process proof as bounded JSON
through the existing authenticated job artifact uploader. The result journal and
publication bind its task-file ID and SHA-256. A folder `result_exit_code` is the
native observer's worker exit code. Git results keep their existing acceptance
command semantics. Neither worker success nor an artifact upload completes the
task: the hub's independent verifier owns that decision.

See [process ownership](console-local-process-ownership.md) for exact native
authority, provider routing, stopped work and restart limitations.
