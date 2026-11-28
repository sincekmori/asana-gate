# asana-gate

## 0.6.0

### Minor Changes

- 44037f9: `asana-gate check` now checks every object a policy names, wherever a rule names it: the tags, users, projects, teams and custom fields of `require` and `apply`, beside those of `where`.
  It also checks that each custom field can hold the values a rule writes for it: an option of an enum field, whose options it lists with their gids, a user of a people field, an object of a type a reference field takes.
- 44037f9: A policy now names every object by its gid, in quotes, and a name is refused when the policy loads: a name tells no object from another, since two projects may share one and whoever renames an object would decide what a rule covers.
  This goes for the workspace, for every `where` key, for the fields under `custom_fields` and for the values of the members that name objects (`tags`, `projects`, `team`, `assignee`, `followers`, `owner`); a user may still be `me`, and no longer an email.
  A `custom_field` scope matches a field by the gid of what it holds (an option, a user, another object), where an option's name used to match too, and by the text Asana displays when it holds none.
  A refusal lists the gids a member may take (`custom_fields.<gid> must be one of <gid>`).
  Reading a policy now asks Asana who the token belongs to and what the workspace is called, and nothing else, so the on-disk cache of the workspace's names is gone with everything that served it: the `cache` settings, `ASANA_GATE_CACHE`, the `asana-gate cache` command, and `AsanaNameResolver` and `FileListingCache` in the library, where `policyFor(client, sources)` now compiles a policy for a client.
  The directory `~/.asana-gate/cache` is no longer read and can be deleted.
  `asana-gate init --workspace` takes a gid.
- 44037f9: The gate now judges every request by what Asana says while it runs: it keeps nothing of Asana's answers between requests, where the MCP server used to keep where an object lives for half a minute, a project's team and the contents of a portfolio for five.
  A task somebody moves out of a project, a project moved to another team and a project taken out of a portfolio are judged where they are from the next request on.
  Within a request the gate still asks for each thing once, and once the request has written it asks again for what judges the answer.
  A request therefore costs a read for each object it must place, where a running server used to answer some from memory: about one more request to Asana per operation, and a listing of each portfolio the policy names per request.
  The project and the section a task is in are now judged by what placed the task, without a request for either, in a single object and in every item of a list.
  In the library, `Gate` takes no `loader` and has none: each request gets a `FactsLoader` of its own, whose `objectTtlMs`, `projectTtlMs` and `portfolioTtlMs` options and `invalidate` method are gone.

## 0.5.1

### Patch Changes

- ecdddc9: The objects an event or a notification names are now shown as the policy says, like any other reference: `resource.notes` on `GET /events` read a task's redacted notes (verified live).
  Both are now judged whatever fields a request selects: the gate asks for an event's `action`, `resource` and `parent` and a notification's `work_objects` beside the caller's fields and cuts the answer back to those, where an event of a hidden task used to pass once `opt_fields` left its `resource` out (verified live), and the event of a deleted object to go once they left its `parent` out.
- ecdddc9: An object the policy hides is now removed wherever an answer nests it, and a visible one redacted as the place it lives in says, where both used to hold only for the tasks, projects, sections, portfolios, goals and teams an object carries directly.
  A project and a section named by a task's `memberships` and the values of a `reference` custom field passed unchecked, so `memberships.project.notes` read a project's redacted notes, a task of a policy that allows tasks alone showed the project it is in, and a reference custom field showed the name of a hidden task (verified live).
  So did an object that lives inside another: a project showed its latest status update, text included, whatever the policy says about status updates there, and a notification the text of its story (verified live).
  An object that lives at workspace level, such as a task's assignee, still stays where a visible object names it, and now loses the members the policy redacts.
  A `reference` custom field that loses a value now answers `display_value: null`, since Asana's text for the field names every object it holds, and the gate asks for the references beside that text when a request selects the text alone.
  An answer costs a request for each project, section, status update or story it shows that the gate has not loaded already, unless the answer itself carries what the object lives in; nothing is loaded for a member the answer leaves out.
- ecdddc9: A create or an update that sets a `reference` custom field to an object the policy hides is now refused with the 404 of a gid that names nothing, like every other request that names a hidden object: it used to reach Asana, whose answer told a hidden object (accepted, or refused for its type) from one that does not exist (verified live).
  To tell such a field from any other, the gate reads the definition of each custom field a request sets, once per half minute.
  A hidden object among several types a request may name (the item of a portfolio, the resource of a goal relationship) now answers with the same message as one that does not exist, where the message used to name the hidden object's type.

## 0.5.0

### Minor Changes

- 8725179: `asana_allowed_actions` now also tells the constraints in force where the object is, as `constraints`, so an agent can write a request that fits instead of learning each constraint from a refusal: per resource and member what a create or update must carry (`require`) or may not set (`forbid`), what the policy fills in (`apply`) or leaves out of answers (`redact`), and per action the caps (`limit`) and the confirmations (`confirm`), each value with the gid to send.
  The operators read as a policy writes them, which `asana-gate explain` now does too (`not_in` where it printed `notIn`).
- 8725179: Every object is now answered with the fields the request asked for, as a `GET` by gid already was: the members the gate reads beside them to judge an object (a task's `workspace`, `parent` and `memberships`, a project's `team`) no longer come back in the items of a list or in the answer to a write that names `opt_fields`.
  The items of a list asked for without `opt_fields` carry their `gid` and name (or what tells apart an object that has no name) and their `allowed_actions`, so ask for the members you need: a caller that read `memberships` or `parent` off a list without asking for them must now name them.
  Nothing is loaded from Asana any more to check a member the answer leaves out: a list of projects, for one, no longer costs a request per team its projects are in.

### Patch Changes

- 8725179: The MCP server no longer lists a tool for an action that a policy file allows and denies over the very same scope (`allow: ["task:*"]` with `deny: [task:delete]` beside it listed `asana_delete_task`, whose every call was refused), and `asana-gate check` no longer counts such an action among the explicit-only actions granted.
  Nor does a `read` that only a filter rule allows count any more, since a tag, assignee, custom field or state filter never makes an object visible: the reading tools such a rule alone stood behind were listed for nothing.
- 8725179: `init --agent claude-code` now also denies reading the token file in the home directory and lists the token's variable under `sandbox.credentials.envVars`: with Claude Code's sandbox on, no command the agent runs finds the token files or the variable, `asana-gate` in its shell included, while the MCP server still reads the token.
  The README now tells the two apart: instructions keep an agent that follows them to the gate wherever the token is, and only a token out of the agent's reach makes the policy hold against one that does not.

## 0.4.3

### Patch Changes

- 369f2f2: The instructions `asana-gate init --agent` prints now name Asana's own `asana-cli` among the ways an agent must not reach Asana, and the README and the skill say not to export the token where an agent runs commands, since `asana-cli`, which Asana announced for agents on 2026-11-13, reads `ASANA_ACCESS_TOKEN` by default and sends every request without a policy.

## 0.4.2

### Patch Changes

- bdb107b: Duplicating a project, a portfolio or a task and instantiating a project or task template are now held to the constraints on the members their request sets, as a create of its own would be (the `name`, and an instantiated project's `team` and `privacy_setting`), where they used to pass unshaped, so a template could make a project the policy's `require` forbids (verified live); what the template or the copy brings is left to it.
- bdb107b: Taking a local custom field (one outside the workspace's library, such as a field defined in place on a project) off a project, a portfolio, a goal or a table now needs `custom_field:delete` as well as `custom_field_setting:delete`, because Asana deletes such a field with its setting (verified live), and the README now says that project templates follow their team rather than a project.
- bdb107b: An `in` or `not_in` requirement now admits only the values Asana takes, the gids of the options, tags, projects and teams the policy names (users still by `me` or an email as well), where it used to pass their names on to a refusal from Asana (verified live); its refusal lists each value with its gid, and `asana-gate explain` shows such sets and patterns instead of `{}`.
- bdb107b: Creating a record now needs the table it goes into to be visible to the policy, and a record search may filter only by tables and teams the policy shows, like every other object a request names (a policy without `table:read` could put records into any table, verified live).
- 39d163d: `PUT /sections/{gid}` needs `section:update` alone again, also when it carries `insert_before` or `insert_after`: Asana changes only a section's name there and leaves the order as it was (verified live), so asking for `section:reorder` refused renames that moved nothing.

## 0.4.1

### Patch Changes

- 9c5cff8: A custom field that a request puts on or takes off a project, a portfolio, a goal or a table by gid must now be visible to the policy, like any other object a request names: without `custom_field:read` the request answers 404 where it used to pass.

## 0.4.0

### Minor Changes

- 4238ab1: The dedicated tools and commands now cover what Asana's own MCP server offers, apart from its status overview and its interactive previews: the followers and dependents of a task, the members, custom fields and task counts of a project, the teams of a user, task and project templates, Inbox notifications, AI Teammates, tables and records.
  The tools that were there take more of Asana's members: more filters in `asana_search_tasks` and `asana_list_task_stories`, `resource_subtype` and `approval_status` on a new task, `assignee_section` on tasks, `privacy_setting`, `default_access_level`, `default_view`, `owner`, `icon` and custom field values on projects, and AI Teammates in `asana_typeahead`.
  A tool called with an argument its input does not declare now refuses the call and names the argument, where it used to drop the argument and run without it: `asana_create_comment` given `parent_comment` posted a top-level comment.
  Send such a member through `asana_request`, which takes every member of an operation.
  `asana_get_task` answers the task's latest comments and its direct subtasks in the same call when asked (`include_comments`, `comment_limit`, `include_subtasks`), and `asana_get_project` its sections and task counts (`include_sections`, `include_task_counts`); a part that is refused is `null`.
  Two requests that passed on less than they do are now held to it: the `approval_status` of an approval task, which completes or reopens the task, needs `task:complete` like `completed` (and a new approval task in a status other than pending counts as completed where a rule filters on `completed`), and a custom field defined in place while it is put on a project, a portfolio, a goal or a table needs `custom_field:create` in the workspace and is shaped by the constraints on `custom_field`.
  Both passed through `asana_request` before; a policy that relied on either must now grant the action.

## 0.3.2

### Patch Changes

- f8f258c: `init --agent vscode` now puts the server into `.mcp.json`, which GitHub Copilot in VS Code reads as Claude Code and Copilot CLI do, instead of `.vscode/mcp.json`, the file of the Local agent harness that VS Code has deprecated.
  Naming `claude-code` and `vscode` together writes that one file once.
  An entry an earlier version left in `.vscode/mcp.json` is no longer updated or checked: delete it, because VS Code still forwards that file to Copilot.

## 0.3.1

### Patch Changes

- 17457cb: asana-gate is now listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.sincekmori/asana-gate`: the package declares that name (`mcpName`), and every release publishes its entry (`server.json`) there.

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
