# Fix: a task at `tests_run` can be closed on OpenCode 2 again

## What changed

The task-completion gate (`TASK_COMPLETION_GATE_VIOLATION`) no longer denies the OpenCode 2 Code Mode `execute` wrapper. It now judges only the tool calls inside it.

On OpenCode 2, every swarm tool runs inside the host's `execute` tool, which takes a JavaScript program. The host fires `tool.execute.before` for that call, and again for each nested `tools.<name>()` call under its own name. The completion gate runs for every tool. It judged the outer call by its name, and `execute` is neither read-only nor a recovery tool. So once a task reached `tests_run`, every `execute` call was refused. That included the one holding the nested `update_task_status` call, the only thing that clears the gate. The architect could not mark the task complete, start the next task, or call `declare_scope`, and the session stalled.

The gate now skips only the wrapper. It requires the v2 adapter's per-call Code Mode mark (`src/hooks/code-mode-wrapper.ts`, added in #3446) and the exact tool name `execute`. Nested calls reuse the wrapper's call id but carry their own tool name, so they are still checked one by one:

- `update_task_status` for the awaiting task passes.
- Read-only and recovery tools such as `check_gate_status` pass.
- A call that would start a different task, such as `declare_scope` or a coder `Task`, is still denied unless the two tasks are provably disjoint (the gate's existing carve-out).

OpenCode 1 hosts never mark a call, so their behavior is unchanged. An unmarked `execute` call is gated as before.

## Why

The same shape check feeds the Full-Auto classifier, which honors it only with an opt-in (`trust_code_mode_wrapper`), because a third-party tool named `execute` taking `code` looks the same. The completion gate needs no opt-in. It orders task workflow and is not a permission boundary. A misattributed mark skips the completion check for that one call only, and its nested calls are still gated.

## Impact

- OpenCode 2: an architect stopped with `TASK_COMPLETION_GATE_VIOLATION` can call `update_task_status` through Code Mode and continue. No state repair is needed, because the task's evidence already records `tests_run`.
- OpenCode 2: while a task awaits completion, the wrapper's in-sandbox `fetch` is no longer blocked. Before, the gate blocked it only as a side effect of denying the whole wrapper. No swarm hook sees in-sandbox `fetch`, as with any Code Mode program. Newer OpenCode 2 sources check it against the host's `webfetch` permission. A direct `webfetch` call is still denied while a task awaits completion.
- OpenCode 1: no change.
- Not changed here: the PR-workflow gates (PR_REVIEW read-only, PR_FEEDBACK publication and checkout recovery) and Full-Auto's paused or unreadable-state guards still judge the wrapper by its name. Those are permission boundaries, and the wrapper also exposes `fetch` and `Function`, which no hook sees.
