---
"asana-gate": patch
---

A `custom_fields` constraint that mixes operators with field names is refused when the policy loads, instead of dropping the fields' constraints or overwriting the whole member, and so is a `min` or `max` that is no date.
A date-time without an offset is read as UTC, the same on every machine.
`in` and `not_in` on `assignee`, `followers` and `owner` compare the users a request names however it names them (`me`, a gid or an email), and a task created without an assignee is no longer taken for the token's user when that user has no email.
The same change now needs the same permission whatever the route: a workspace's lists and task search are filtered item by item like `GET /projects?workspace=`, a subtask keeps its parent's subtree when it is created with projects or added to one, adding a subtask to a section of its parent's project needs `create`, and moving a section by `PUT` needs `section:reorder`.
A `fields` allowlist may name a task's `dependencies` and `dependents`, which made dependency operations impossible to allow before.
A user's or an administrator's policy that names a workspace this token cannot see is not in force, as the README says, rather than failing every command; `check` also warns when the workspace itself is not readable, which every request starting from it needs.
A confirmation answers only the call with the arguments it was asked for, and a person on an older connection has ten minutes to answer instead of the SDK's default of one minute.
Over stdio the server exits with 0 when the client closes stdin, instead of Node's 13.
`init --agent` changes an existing `mcp.json` only where the server goes, keeping its comments (through `jsonc-parser`, now a dependency); the home directory is no longer taken for a project when `$HOME` is a symbolic link; and `token set` lists the token file it wrote in `.gitignore` whatever `token.file` calls it, or says nothing about git when the file is outside `.asana-gate`.
An empty gid, `.` and `..` name no object (they were sent as another path), `asana_create_task` with an empty `projects` names the workspace, a batch inside a batch is refused, a short chunk of a large batch no longer shifts later results onto earlier actions, and a write Asana answers with an error still drops what the gate knew of the object.
