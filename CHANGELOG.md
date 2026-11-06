# asana-gate

## 0.3.0

### Minor Changes

- 385481b: The MCP server's instructions now tell the agent whom every request runs as: the gid of the token's user and the name and gid of the workspace, plus the user's name and email as far as the policy would show them through `GET /users/me`.

### Patch Changes

- 1e6f9fc: A `custom_fields` constraint that mixes operators with field names is refused when the policy loads, instead of dropping the fields' constraints or overwriting the whole member, and so is a `min` or `max` that is no date.
  A date-time without an offset is read as UTC, the same on every machine.
  `in` and `not_in` on `assignee`, `followers` and `owner` compare the users a request names however it names them (`me`, a gid or an email), and a task created without an assignee is no longer taken for the token's user when that user has no email.
  The same change now needs the same permission whatever the route: a workspace's lists and task search are filtered item by item like `GET /projects?workspace=`, a subtask keeps its parent's subtree when it is created with projects or added to one, adding a subtask to a section of its parent's project needs `create`, and moving a section by `PUT` needs `section:reorder`.
  A `fields` allowlist may name a task's `dependencies` and `dependents`, which made dependency operations impossible to allow before.
  A user's or an administrator's policy that names a workspace this token cannot see is not in force, as the README says, rather than failing every command; `check` also warns when the workspace itself is not readable, which every request starting from it needs.
  A confirmation answers only the call with the arguments it was asked for, and a person on an older connection has ten minutes to answer instead of the SDK's default of one minute.
  Over stdio the server exits with 0 when the client closes stdin, instead of Node's 13.
  `init --agent` changes an existing `mcp.json` only where the server goes, keeping its comments (through `jsonc-parser`, now a dependency); the home directory is no longer taken for a project when `$HOME` is a symbolic link; and `token set` lists the token file it wrote in `.gitignore` whatever `token.file` calls it, or says nothing about git when the file is outside `.asana-gate`.
  An empty gid, `.` and `..` name no object (they were sent as another path), `asana_create_task` with an empty `projects` names the workspace, a batch inside a batch is refused, a short chunk of a large batch no longer shifts later results onto earlier actions, and a write Asana answers with an error still drops what the gate knew of the object.

## 0.2.0

### Minor Changes

- 4f5056b: The policy in force is now made of up to three files: the project's policy (or the file `--policy` points at), your own `~/.asana-gate/policy.yaml` and an administrator's `managed-policy.yaml`.
  Every file that exists is read, and an action is allowed only when every file allows it, each by its own rules and its own default of deny; constraints add up across files, `fields` allowlists intersect, and the stronger file's `apply` wins a tie.
  A file other than the project's may leave `workspace` out; one that names another workspace is not in force there, which `check` reports.
  `check` lists every file in force, and messages name a rule by its file when there are several (`user rules[2]`).

## 0.1.1

### Patch Changes

- b028ee4: The package no longer ships source maps, which made up most of its size; the bundled files are unminified, so stack traces stay readable without them.

## 0.1.0

### Minor Changes

- e65850a: First release: a policy-gated Asana API for AI agents, served over MCP (stdio and Streamable HTTP) and as a command line.
  A YAML policy covering every Asana REST operation decides, per scope, what an agent may do and how its requests are shaped (`require`, `apply`, `forbid`, `redact`, `limit`, `confirm`, with confirmations over MCP elicitation bound to the question asked); an object the policy hides answers exactly like a nonexistent one, on every path and through every nested reference, list, event and batch action, and every response carries `allowed_actions`.
  The gate reads from Asana only what the policy needs, answers a read from the request that checks it, plans `POST /batch` and the batch tools (up to 50 tasks at once) per action, and talks to Asana at its concurrency limits with `Retry-After` retries that never repeat a write Asana may have run.
  Around it: layered settings (`~/.asana-gate`, the project's `.asana-gate`, managed settings) with an opt-out on-disk cache of workspace names and a rotated log file, token files kept out of git (`asana-gate token set`), a `check` that verifies the settings, the token and every object the policy names, an MCP tool list shaped by the policy, `init --agent claude-code|vscode|cursor` to wire a repository for an agent with skill copies that refresh themselves, and a command line that serves the gate (`mcp`, `check`, `explain`, `init`, `token`, `settings`, `cache`) and operates Asana through it (`<resource> <verb>`, `api`).
