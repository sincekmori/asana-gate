---
"asana-gate": patch
---

The MCP server no longer lists a tool for an action that a policy file allows and denies over the very same scope (`allow: ["task:*"]` with `deny: [task:delete]` beside it listed `asana_delete_task`, whose every call was refused), and `asana-gate check` no longer counts such an action among the explicit-only actions granted.
Nor does a `read` that only a filter rule allows count any more, since a tag, assignee, custom field or state filter never makes an object visible: the reading tools such a rule alone stood behind were listed for nothing.
