# asana-gate

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
