# asana-gate

A declarative access-control policy in front of the [Asana](https://asana.com) REST API, served to AI agents over [MCP](https://modelcontextprotocol.io).

```
MCP client ──MCP──▶ asana-gate ──policy──▶ Asana REST API
```

You give an agent a Personal Access Token through asana-gate instead of directly.
A policy file then decides, per project, section, task, tag or assignee, what the agent can see and do.
Everything else does not exist for the agent.

## Why

An Asana token grants everything its owner can do.
Agents need much less: read this team, update tasks in that project, never touch the Done section, never delete.
asana-gate turns such sentences into a YAML file and enforces it on every one of Asana's REST operations.

- **The policy is the only source of permissions.** The token's rights are an upper bound; the default is deny.
- **Invisible, not forbidden.** Objects the policy hides answer exactly like nonexistent gids (a 404 with Asana's own wording), and never appear in lists, searches, typeahead or events.
- **Judged by what Asana says now.** Between requests the gate keeps nothing of what Asana answered: no cache on disk, none in memory. A task moved out of a project a minute ago is judged where it is.
- **Every endpoint is covered.** Every operation of Asana's OpenAPI definition is classified. A plain read, update or delete of one object (`GET /tasks/{task_gid}`) is classified from its path; any other operation Asana adds fails the build until it is classified, and the weekly OpenAPI report names every new one for review, so none passes through unreviewed.
- **MCP as specified.** stdio and Streamable HTTP transports, no client-specific extensions.

## Install

```sh
npm install -g asana-gate
```

Node.js 24 or later is required.
`npx asana-gate` works too.
The server is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.sincekmori/asana-gate`, for the clients and catalogs that read it.

## Quick start

1. Create a [Personal Access Token](https://developers.asana.com/docs/personal-access-token) and give it to asana-gate: exported for this shell, or saved in your home directory in a file only you can read (it is never printed).

   ```sh
   export ASANA_ACCESS_TOKEN="…"   # this shell only
   asana-gate token set --user     # or keep it in ~/.asana-gate/token, typed unseen or piped in
   ```

2. Let asana-gate look at your workspace and create the project's `.asana-gate` directory: a policy skeleton, a settings file and a `.gitignore` that keeps personal settings and the token file out of git.

   ```sh
   asana-gate init
   ```

3. Edit `.asana-gate/policy.yaml`, then validate it: every object the rules name is checked to exist in the workspace, and the token is checked.

   ```sh
   asana-gate check
   ```

4. Serve it to your MCP client.

   ```sh
   asana-gate mcp
   ```

   For Claude Code, `asana-gate init --agent claude-code` writes the project's `.mcp.json`, a copy of the skill and the rules that keep the token from the agent (see [Agents](#agents)).
   For any other MCP host, register the command; started inside the project directory, `asana-gate mcp` finds the policy and the token by itself, and `-C` points it at the project when the host starts it elsewhere:

   ```json
   {
     "mcpServers": {
       "asana-gate": {
         "command": "npx",
         "args": ["-y", "asana-gate", "mcp", "-C", "/path/to/project"]
       }
     }
   }
   ```

## Policy

A policy names one workspace and lists rules.
Each rule has a scope (`where`), the actions it allows or denies there, and optionally constraints on the requests made there.

```yaml
version: 1
workspace: "1200000000000001" # Acme

rules:
  # No `where`: the whole workspace. Read everything.
  - allow: [read]

  # Everything the Platform team owns is writable (create and update, no delete).
  - where: { team: "1200000000000011" }
    allow: [write]

  # Full task work in the Backend project, plus comments and tags.
  - where: { project: "1200000000000123" }
    allow: ["task:*", story:create, tag:apply]

  # ...but its Done section is frozen (still visible; deny: ["*"] would hide it).
  - where: { section: "1200000000000132" }
    deny: [modify]

  # Tasks tagged ai-ok may be updated wherever they are already visible.
  - where: { tag: "1200000000000141" }
    allow: [task:update]

  # Read the Design System project, and update only these task fields in it.
  - where: { project: "1200000000000124" }
    allow: [read]
    fields: { task: [completed, assignee, due_on] }

  # Tasks created in the AI backlog get a prefix and the ai-generated tag, must have
  # a due date, are capped at 20 an hour, and are deleted only after a person confirms.
  - where: { project: "1200000000000125" }
    allow: ["task:*"]
    require: { task: { due_on: true } }
    apply: { task: { name: { prefix: "[AI] " }, tags: { add: ["1200000000000142"] } } }
    limit: { "task:create": { max: 20, per: 1h } }
    confirm: [task:delete]

  # Hide the Payroll project completely.
  - where: { project: "1200000000000126" }
    deny: ["*"]
```

A policy names every object by its gid, written in quotes.
A name tells no object from another: two projects may share one, and anybody who may rename a project would decide what a rule covers.
So a rule holds for the object it was written for, whatever that object is called later, and reading a policy asks nothing of Asana but who the token belongs to and what the workspace is called.
Say what a gid stands for in a comment.
The gid of a project, a task, a team, a tag or a portfolio is the number in its Asana URL, and `asana-gate init` lists those of the workspace's teams and projects in the policy it writes; a section, a custom field, an option of one and a user have no such URL, so theirs is read with a request, such as `asana-gate api GET /projects/<gid>/sections`.
`asana-gate check` fails on a gid that names nothing of the kind a scope or a constraint expects there, on an object of another workspace, and on a value a custom field cannot hold; `asana-gate explain <gid>` tells what a gid names and how the policy treats it.
Every scope key accepts one gid or a list (any of them matches).

### Scopes

| Key              | Matches                                                                                  | Level |
| ---------------- | ---------------------------------------------------------------------------------------- | ----- |
| _(none)_         | the whole workspace                                                                      | 0     |
| `team`           | the team and every project in it                                                         | 1     |
| `portfolio`      | the portfolio, its nested portfolios, and every project in them                          | 1     |
| `unhomed: true`  | tasks that belong to no project (and inherit none from a parent task)                    | 1     |
| `project`        | the project and everything in it                                                         | 2     |
| `section`        | the section and the tasks in it                                                          | 3     |
| `subtree`        | a task (gid) and all of its subtasks, recursively                                        | 4     |
| `task`           | exactly that task (gid)                                                                  | 5     |
| `tag`            | filter: tasks carrying the tag                                                           | +     |
| `assignee`       | filter: tasks assigned to `me` (the token's user) or to a user's gid                     | +     |
| `custom_field`   | filter: tasks whose field (by gid) holds one of the values (see below)                   | +     |
| `created_by`     | filter: tasks created by `me` or by a user's gid                                         | +     |
| `completed`      | filter: completed (`true`) or open (`false`) tasks                                       | +     |
| `has_parent`     | filter: subtasks (`true`) or top-level tasks (`false`)                                   | +     |
| `name`           | filter: tasks whose name satisfies `prefix`, `suffix`, `contains` or `matches` (a regex) | +     |
| `overdue`        | filter: tasks whose due date has passed (`true`) or not (`false`)                        | +     |
| `due_within`     | filter: tasks due within a duration from now, such as `7d`                               | +     |
| `created_within` | filter: tasks created within a duration, such as `24h`                                   | +     |

Hierarchy keys in one `where` are ANDed.
Filters (`tag`, `assignee`, `custom_field` and the state filters below them) are ANDed with the hierarchy keys and never make an object visible on their own: they narrow or widen what may be done with objects that another rule already lets the agent read, and they may hide objects (`deny: [task:read]`).
For a create request, the filters see the object the request would create: its name after `apply`, the token's user as its creator, its due date and so on.
A `custom_field` filter is written `{ "<field gid>": <value> }`, and a value is what the field holds: the gid of an option, of a user or of another object for a field that holds objects, and the text Asana displays for one that holds none (a text, a date, a number as its format shows it, such as `5.00`).

Objects that are not tasks live where the object they belong to does.
Stories, attachments and time entries follow their task (a story on a goal and an attachment on a project brief follow that instead); sections, project briefs, task templates and project memberships follow their project; status updates and memberships follow their project, portfolio or goal, and allocations, budgets and rates their project or portfolio.
A webhook follows the object it watches, which may be a task or a team as well.
Project templates and team memberships follow their team, as does a goal that has one, and a goal relationship follows the goal it supports.
Tags, users, custom field definitions, tables, records and most administrative resources live at workspace level.

### Actions

An action is `<resource>:<verb>`.
Groups and wildcards expand to concrete actions: `read` (every `read`), `modify` (every other verb, the complement of `read`), `write` (`read` plus every creating and modifying verb), `admin` (everything), `*` (same as `admin`), `task:*`, `*:delete`.
A rule takes part only for the actions it names, so a scope is made read-only with `allow: [read]` and `deny: [modify]` together: the deny keeps a broader `allow` elsewhere from reaching it, and unlike `deny: ["*"]` it leaves the objects visible.

| Resource                                                                                                                                                                                         | Verbs                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `task`                                                                                                                                                                                           | `read` `create` `update` `delete` `complete` `move` `add_project` `remove_project` `set_parent` `assign` |
| `story` `project_brief` `goal` `goal_relationship` `membership`                                                                                                                                  | `read` `create` `update` `delete`                                                                        |
| `attachment`                                                                                                                                                                                     | `read` `create` `delete`                                                                                 |
| `section`                                                                                                                                                                                        | `read` `create` `update` `delete` `reorder`                                                              |
| `project`                                                                                                                                                                                        | `read` `create` `update` `delete` `archive` `manage_members`                                             |
| `portfolio`                                                                                                                                                                                      | `read` `create` `update` `delete` `manage_members`                                                       |
| `status_update`                                                                                                                                                                                  | `read` `create` `delete`                                                                                 |
| `tag`                                                                                                                                                                                            | `read` `create` `update` `delete` `apply`                                                                |
| `custom_field` `allocation` `budget` `rate` `role` `record` `table` `ooo_entry` `time_tracking_category` `time_tracking_entry`                                                                   | `read` `create` `update` `delete`                                                                        |
| `custom_field_setting`                                                                                                                                                                           | `read` `create` `delete`                                                                                 |
| `project_template`                                                                                                                                                                               | `read` `create` `delete`                                                                                 |
| `task_template`                                                                                                                                                                                  | `read` `delete`                                                                                          |
| `team`                                                                                                                                                                                           | `read` `create` `update` `manage_members`                                                                |
| `workspace`                                                                                                                                                                                      | `read` `update` `manage_members`                                                                         |
| `user` `notification` `project_portfolio_setting`                                                                                                                                                | `read` `update`                                                                                          |
| `access_request` `timesheet_approval_status`                                                                                                                                                     | `read` `create` `update`                                                                                 |
| `webhook`                                                                                                                                                                                        | `read` `create` `update` `delete`                                                                        |
| `organization_export`                                                                                                                                                                            | `read` `create`                                                                                          |
| `export`                                                                                                                                                                                         | `create`                                                                                                 |
| `rule`                                                                                                                                                                                           | `trigger`                                                                                                |
| `project_membership` `portfolio_membership` `team_membership` `workspace_membership` `user_task_list` `custom_type` `job` `event` `audit_log` `ai_studio_usage` `agent` `time_period` `reaction` | `read`                                                                                                   |

`read` is the prerequisite of every other verb: an object whose `read` is not allowed is invisible, whatever else a rule says.

Some verbs are implied by the request body: updating a task's `completed` needs `task:complete`, and so does the `approval_status` of an approval task, which Asana keeps in step with it (a new approval task in a status other than pending counts as completed, too); its `assignee` needs `task:assign`, a project's `archived` needs `project:archive`; every other member needs `update`.
A custom field defined in place where one is put on a project, a portfolio, a goal or a table is created by that request, so it needs `custom_field:create` in the workspace as well, and the constraints on `custom_field` shape the definition.
One named by gid must be visible to the policy, like any object a request names, to be put on and to be taken off; so must the table a new record goes into, and the tables a record search filters by.
So must the objects a create or an update sets a `reference` custom field to: a value that names a hidden object is refused with the 404 of one that names nothing.
Only its definition tells such a field from any other, so the gate reads the definition of each custom field a request sets, once per request.
Taking a local field off again (one outside the workspace's library, as a field defined in place on a project is) deletes it, as live checks showed, so that needs `custom_field:delete` as well; a library field needs only `custom_field_setting:delete`.

**Explicit-only actions** move data out of Asana or out of asana-gate's control, so no group or wildcard grants them; a policy must spell them out: `webhook:create`, `webhook:update`, `export:create`, `organization_export:create`, `organization_export:read`, `audit_log:read`.
Asana restricts some operations further on its own side, and the gate passes its answer through: audit log events, workspace events, organization exports and graph exports are served only to a service account of an Enterprise-tier organization, task templates, allocations, rates and custom roles take a paid tier, and the early-access Agents endpoints answer only requests that carry the `ai_teammate_actors` flag, which `asana.enable` in the [settings](#configuration) sends.
Where a policy restricts rather than grants (`deny`, `confirm`, `limit`), groups and wildcards do cover them, so `deny: [modify]` also refuses `webhook:create` there.

### `fields`

`fields` on a rule grants `<resource>:update` limited to the listed members (plus the verb a member stands for, such as `task:complete` for `completed`).
An update that touches any other member is refused with a 403 naming the member.
A task's `dependencies` and `dependents`, which their own operations change (`addDependencies`, `removeDependents`, …), may be listed too.
It applies to updates only; creating an object is governed by `create` alone.

### Constraints

Besides allowing and denying actions, a rule can constrain the requests made in its scope and the responses they get: what a member must look like, what is filled in, what may not be set, what is hidden, how often an action may run and what a person must confirm.
A rule may consist of constraints alone, without `allow` or `deny`; its `where` decides where they are in force.

```yaml
rules:
  - where: { project: "1200000000000125" } # AI backlog
    allow: ["task:*", story:create]
    require:
      task:
        name: { prefix: "[AI] ", max_length: 80 }
        due_on: { present: true, min: today, max: "+30d" }
        custom_fields: { "1200000000000161": { in: ["1200000000000171"] } } # Owner: AI
    apply:
      task:
        name: { prefix: "[AI] " }
        tags: { add: ["1200000000000142"] } # ai-generated
        custom_fields: { "1200000000000161": "1200000000000171" } # Owner: AI
    forbid: { task: [html_notes, followers] }
    redact: { task: [notes] }
    limit: { "task:create": { max: 20, per: 1h } }
    confirm: [task:delete, "project:*"]
```

| Clause    | Acts on                    | Meaning                                                                                                                  |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `require` | create and update requests | per resource and member, what the value must satisfy; a request that does not is refused with a 400 naming every problem |
| `apply`   | create and update requests | per resource and member, what is filled in or rewritten before the request reaches Asana                                 |
| `forbid`  | create and update requests | per resource, members the request may not set                                                                            |
| `redact`  | responses                  | per resource, members removed from every object the agent sees                                                           |
| `limit`   | actions                    | per action, at most `max` requests per `per` (`30m`, `24h`, `7d`); the next one is refused with a 429                    |
| `confirm` | actions                    | actions a person must confirm before they run: 428 when nobody can be asked, 403 when they decline                       |

Members are the request members of Asana's API (`name`, `due_on`, `assignee`, `projects`, `tags`, …); a member Asana does not accept for the resource is an error when the policy loads.
`custom_fields` nests by the gid of each field, and a field's values are written as a request sends them: the gid of an option, a text, a number.
Where a member names objects (`tags`, `projects`, `team`, and the users of `assignee`, `followers` and `owner`), the values of `in`, `not_in` and `apply` are their gids, and a user may be `me`; a name there is an error when the policy loads.
A request names them as Asana takes them, by gid (a user also by `me` or an email, which the gate turns into the gid before it compares), so a refusal lists the gids, as in `custom_fields.1200000000000161 must be one of 1200000000000171`.

A requirement combines operators, all of which must hold:

| Operator                         | Meaning                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `present: true` (or just `true`) | required when creating; cannot be cleared when updating                                                                                                                                              |
| `prefix`, `suffix`, `contains`   | the string must start with, end with or contain the text                                                                                                                                             |
| `matches`, `not_matches`         | the string must, or must not, match the regular expression                                                                                                                                           |
| `min_length`, `max_length`       | bounds on the string's length                                                                                                                                                                        |
| `in`, `not_in`                   | the value, or every element of a list, must (not) be one of these; objects compare by gid                                                                                                            |
| `min`, `max`                     | bounds on a number, or on a date: `YYYY-MM-DD`, ISO 8601, `today`, `now`, `+7d`, `-1d` (a date-only value such as `due_on` is compared by calendar day, and a time without an offset is read as UTC) |

An application is a bare value (a default) or an object of operators:

| Operator           | Meaning                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `default`          | set when the member is absent or empty (on update, only when the request clears it) |
| `value`            | always set, whatever the request says                                               |
| `prefix`, `suffix` | added to the string unless already there                                            |
| `add`              | values a list member must contain                                                   |

When several rules apply to one object, every `require` holds, the most specific rule's `apply` wins per member, and `forbid`, `redact` and `confirm` add up.
A request is shaped in the order `apply`, `forbid`, `require`, so a default or a prefix can satisfy a requirement.
A project, portfolio or task made from a template or as a duplicate is shaped on the members its request sets itself, as a create of its own would be (its `name`, and an instantiated project's `team` and `privacy_setting`); what the template or the copy brings is left to it, so a requirement on another member does not hold such a request back.
Limits count per rule and action inside one gate process, over a sliding window, and a refused request does not count; they are a brake on runaway agents, not an audit trail.

### How a request is decided

1. The request is matched to one of Asana's operations, and the objects it touches are loaded from Asana to find their place: workspace, team, portfolios, project, section, parent tasks, tags, assignee, custom field values.
2. For each action the operation needs, the most specific matching rules decide.
   Specificity is the hierarchy level of the scope (see the table), then the number of filters; between rules of equal specificity, `deny` wins.
   A rule that mentions neither the action nor the scope does not take part.
   No matching rule means deny.
3. A task multi-homed in several projects must be allowed in every one of them; if any of its projects hides it, the task is invisible.
4. A subtask with no project of its own takes its placement from the nearest ancestor that has one (up to five levels); failing that it is unhomed.
5. Invisible objects answer with Asana's "Not a recognized ID" 404.
   Visible objects on which the action is not allowed answer with a 403 whose message starts with `asana-gate:`.
6. A create or update request is then shaped by the constraints in force: `apply` completes it, and a member that breaks `forbid` or `require` refuses it with a 400 naming every problem.
7. A `limit` that is already full refuses with a 429; an action under `confirm` runs only after a person confirms (428 when nobody can be asked, 403 when they decline).
   The order matters: a later refusal never reveals what an earlier one hides, nobody is asked to confirm a request that would be refused anyway, and a refused request does not count against a limit.
8. Lists, searches, typeahead and events are filtered; nothing says how many items were removed (`GET /projects/{gid}/task_counts` is the exception: it is passed through and counts the project's hidden tasks too).
   A filtered page is refilled from the following pages so that it stays as full as asked for, never fuller.
   A `limit` or `confirm` on a read action applies to lists of that resource as well, once per request.
9. Every object in a response carries `allowed_actions`, the actions the policy currently allows on it, so an agent can plan before acting; members under `redact` are removed.
   Nested references to hidden objects (a subtask's `parent`, `dependencies`, a job's `new_task`, the project of one of a task's `memberships`, a value of a `reference` custom field, …) are removed however deep they are nested, and visible ones are redacted as their own place in the policy says; so are the objects an event or a notification names.
   A `reference` custom field that loses a value answers `display_value: null`, because Asana's text for the field names every object it holds.
   This goes for every object that has a place, its own or that of the object it lives in (a project's status update, the story a notification names); an object that lives at workspace level (a task's `assignee` and `tags`, a record a custom field holds) stays where a visible object names it, without the members the policy redacts.
   An object is answered with the fields the request asked for, without those the gate read beside them to judge it; the objects of a list asked for without `opt_fields` carry their `gid` and name, or what tells apart an object that has no name.
10. Every request is judged by what Asana says while it runs.
    What the gate learns to place an object (the project a task is in, the parent of a subtask, what a portfolio holds) it asks for once per request and keeps no longer than the request; once a request has written, it asks again for what judges the answer.
    So a request costs a read for each object it must place beside the request itself: mostly one, none for what the answer carries itself (a task's project, section and team, the ancestors of a subtask), and one listing of each portfolio the policy names, since Asana tells what a portfolio holds and not which portfolios hold a project.

Rule order in the file does not matter.
`asana-gate explain <gid>` shows how the policy treats one object, which rules decided each action, and the constraints in force on it.

### Several policies

The policy in force is made of up to three files: the project's `.asana-gate/policy.yaml` (or the file `--policy` points at), your own `~/.asana-gate/policy.yaml`, and an administrator's `managed-policy.yaml` beside the managed settings.
Every one of them that exists is read, and an action is allowed only when every file allows it: each file is evaluated on its own, with its own most specific rule deciding and its own default of deny, and the answers are combined with AND.
So your own policy is the most you can ever do in any project, the administrator's the most anyone on the machine can do, and the project's what this project allows within those bounds; a file that does not mention an action denies it, exactly as a lone policy would.
With `allow: [read]` in one file and `allow: [task:read]` in another, only tasks can be read, whichever file says which; with `allow: [team:read]` in one and `allow: [task:read]` in the other, nothing can.
Constraints add up across files the way matching rules of one file do, `fields` allowlists intersect, and where two files `apply` the same member at equal specificity the stronger wins: the administrator's, then the project's, then yours.
A file other than the project's may leave `workspace` out, and is then in force wherever the project's policy is; one that names another workspace is not in force there, which `check` reports.
When the project has no policy, yours is the policy, bounded by the administrator's; when only the administrator's exists, it is the policy.
`check` lists every file in force, and messages name a rule by its file when there are several (`user rules[2]`).

## MCP server

`asana-gate mcp` serves the curated tools the policy could ever allow (a read-only policy lists no writing tool), plus three generic ones; the policy is applied when a tool runs.
An action counts as one the policy could allow when every policy file allows it somewhere (a `read` through a filter, which never makes an object visible, aside) without denying it over the very same scope: `allow: ["task:*"]` with `deny: [task:delete]` beside it lists no `asana_delete_task`.
Claude Code loads tool definitions on demand once they grow large, so a long list costs little there.
The server's instructions tell the agent whom every request runs as: the gid of the token's user and the name and gid of the workspace, so it can tell which `assignee`, `created_by` or `followers` in a response is itself; the user's name and email are added only as far as the policy would show them through `GET /users/me` (`workspace:read` and `user:read` at workspace level, then `redact`).

- Curated tools for everyday work: `asana_search_tasks`, `asana_list_tasks`, `asana_get_task`, `asana_create_task`, `asana_update_task`, `asana_create_comment`, `asana_move_task_to_section`, `asana_add_tag_to_task`, `asana_list_projects`, `asana_create_section`, `asana_typeahead`, `asana_get_me` and more.
- `asana_create_tasks` and `asana_update_tasks` take up to 50 tasks at once, `asana_create_records` and `asana_update_records` as many records: the gate checks each one, Asana runs them ten at a time, and the result holds one status per task or record.
- `asana_get_task` answers the task's latest comments and its direct subtasks in the same call when asked (`include_comments`, `include_subtasks`), and `asana_get_project` its sections and task counts (`include_sections`, `include_task_counts`): each part is a request of its own to the gate, and one the policy or Asana refuses is `null`.
- `asana_request` calls any REST operation (`method`, `path`, `query`, `body`) through the same policy; a `POST /batch` through it takes up to 50 actions.
- `asana_operations` lists the operations with the action each one needs; `asana_allowed_actions` tells what the policy allows on one object and, as `constraints`, what it asks of the requests made there: the members a create or update must carry or may not set, what is filled in or left out of answers, and the actions that are capped or wait for a confirmation, each value with the gid to send.

Refusals come back as tool errors whose text is the JSON error body, so agents see the same wording a direct API client would.
A tool refuses an argument its input does not declare, naming it, rather than run without it; `asana_request` takes every member of an operation.

### Confirmations

When a rule's `confirm` covers the action, the server asks the person through MCP elicitation before the call runs; nothing reaches Asana until they say yes.
On a connection that negotiated the 2026-07-28 protocol revision the tool call answers with an `input_required` result carrying a form elicitation and a sealed `requestState`; the client shows it and resends the same call with the answer and the state, which the server checks before executing, so an answer counts only for the question this server asked, about the call with these very arguments.
On an older connection the server sends `elicitation/create` itself and waits up to ten minutes for the answer.
A declined or cancelled confirmation refuses the call with a 403.
A client that does not implement elicitation cannot confirm, so the action does not run (428).
Over the HTTP transport an older client is served one request at a time and cannot receive `elicitation/create`, so confirmations there need a client on the 2026-07-28 revision.

### Transports

```sh
asana-gate mcp                         # stdio (default)
asana-gate mcp --transport http        # Streamable HTTP on http://127.0.0.1:3845/mcp
asana-gate mcp --transport http --host 0.0.0.0 --port 8080 --allowed-host gate.example.internal
```

The HTTP transport validates `Host` and `Origin` headers against loopback plus `--allowed-host` entries (DNS rebinding protection).
Binding to anything but loopback requires a bearer token in `ASANA_GATE_MCP_TOKEN` (or the variable named by `--auth-token-env`), which clients must send as `Authorization: Bearer …`.

## CLI

```
asana-gate mcp                     Serve the policy-gated Asana API as an MCP server
asana-gate check                   Validate the settings, the token and the policy against Asana
asana-gate explain <gid>           Show what the policy allows on one object, and why
asana-gate init                    Create the project's .asana-gate directory; --agent claude-code wires Claude Code
asana-gate token                   Show where the Asana token comes from, or save one (never printed)
asana-gate settings                Show the settings in force and where each value comes from
asana-gate <resource> <verb> …     Operate Asana through the policy
asana-gate api <METHOD> <path>     Call any Asana REST operation through the policy
```

Common options: `-C <dir>` (run as if started in `<dir>`), `--policy <file>` on the commands that read a policy (default: the project's `.asana-gate/policy.yaml`, see [Configuration](#configuration)), `--token-env <NAME>` (default `ASANA_ACCESS_TOKEN`), `--log-level silent|error|warn|info|debug`.
`check` fails (exit code 1) on a problem, such as an object the policy names that no longer exists or an option an enum custom field does not have (its options are listed with their gids), and only warns about the rest.
`init` and `explain` read Asana without the policy's restrictions; they exist to write policies and are not reachable over MCP.
`explain` also prints the constraints in force on the object.

### Operating Asana from a shell

Every curated MCP tool is also a `<resource> <verb>` command with the same inputs, so whatever an agent may do over MCP, a person may do from a shell under the same policy.

```sh
asana-gate task list --project 1200000000000123 --completed-since now
asana-gate task create --name "Write docs" --projects 1200000000000123 --due-on 2026-12-01
asana-gate task update 1200000000000456 --assignee me --completed
asana-gate task move 1200000000000456 --section 1200000000000789
asana-gate task comment 1200000000000456 --text "Done, see the attached diff."
asana-gate task delete 1200000000000456
asana-gate task create-many --tasks @tasks.json
asana-gate section create --project 1200000000000123 --name "Review"
asana-gate find design --type project
asana-gate api GET /tasks/1200000000000456 -q opt_fields=name,completed
asana-gate api POST /tasks -d '{"name": "Write docs", "projects": ["1200000000000123"]}'
```

- The object a verb acts on is a positional argument; everything else is a flag named after the API member (`--due-on` for `due_on`).
- Booleans are switches (`--completed`, `--no-completed`); lists take comma-separated values or repeated flags; `--custom-fields`, `--tasks` and other objects take JSON, inline, from a file (`@tasks.json`, relative to `-C`) or from standard input (`-`); `null` clears a member that allows it.
- Lists print as tables with a hint for the next page, objects as `key: value` lines; `--json` prints the response body as Asana returns it, which `api` always does.
- When the policy wants an action confirmed, the command asks on the terminal; `--yes` (`-y`) confirms in scripts, and a non-interactive run without it is refused.
- Exit codes: 0 on success, 1 when Asana or the policy refuses the request, 2 for a usage error.
- A `limit` counts inside one process, so it binds the MCP server; one-shot commands start from zero each time.
- `asana-gate <resource> --help` lists the verbs; `asana-gate <resource> <verb> --help` lists the flags, with what is required and what the choices are.

Logs go to stderr and, by default, to `~/.asana-gate/logs/asana-gate.log` (`log.file` in the [settings](#configuration)).
The token is never written to logs, errors, URLs or responses.
At `info` level the client also reports the API changes Asana announces in its `Asana-Change` response header.

## Configuration

asana-gate keeps its files the way Claude Code does: a `.asana-gate` directory in the project, one in your home directory, and settings an administrator can manage.

| Layer                 | Where                                                                                                                                                                                                                                                                                                  | For                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Managed               | `/Library/Application Support/asana-gate/managed-settings.yaml` (macOS), `/etc/asana-gate/managed-settings.yaml` (Linux), `%ProgramData%\asana-gate\managed-settings.yaml` (Windows), plus `managed-settings.d/*.yaml`; `managed-policy.yaml` beside them is a policy every other policy is bounded by | An administrator; nothing overrides these |
| Flags and environment | `-C`, `--policy`, `--token-env`, `--log-level`; `ASANA_GATE_POLICY`, `ASANA_GATE_LOG_LEVEL`, `ASANA_GATE_HOME`                                                                                                                                                                                         | One invocation                            |
| Project, personal     | `.asana-gate/settings.local.yaml`                                                                                                                                                                                                                                                                      | You, in this project (ignored by git)     |
| Project, shared       | `.asana-gate/settings.yaml`                                                                                                                                                                                                                                                                            | Everyone working in the project           |
| User                  | `~/.asana-gate/settings.yaml`                                                                                                                                                                                                                                                                          | You, in every project                     |

Higher rows win.
The project is the nearest directory, from the working directory upwards, that holds `.asana-gate`; `asana-gate init` creates it, and `asana-gate init --user` sets up `~/.asana-gate` instead.
`ASANA_GATE_HOME` moves the home directory.
`asana-gate settings` prints the settings in force and the file each value came from.

Every layer may set any of these members, all optional; relative paths are relative to the file that names them.

| Member                                                                          | Default                                                                                                                                     | Meaning                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`                                                                        | the project's `.asana-gate/policy.yaml`, else `./asana-gate.yaml`, else `~/.asana-gate/policy.yaml`, else the managed `managed-policy.yaml` | The project's policy file; `~/.asana-gate/policy.yaml` and `managed-policy.yaml`, when they exist, bound it: every file must allow an action (see [Several policies](#several-policies))                                                              |
| `token.env`                                                                     | `ASANA_ACCESS_TOKEN`                                                                                                                        | The environment variable holding the Personal Access Token (the name Asana's own client libraries use)                                                                                                                                                |
| `token.command`                                                                 | –                                                                                                                                           | A command whose output is the token, such as `op read "op://Private/Asana/credential"`; honored from user and managed settings only                                                                                                                   |
| `token.file`                                                                    | the project's `.asana-gate/token`, else `~/.asana-gate/token`                                                                               | A file holding the token on its first line                                                                                                                                                                                                            |
| `log.level`                                                                     | `warn`                                                                                                                                      | `silent`, `error`, `warn`, `info` or `debug`                                                                                                                                                                                                          |
| `log.file`                                                                      | `~/.asana-gate/logs/asana-gate.log`                                                                                                         | A file log lines are also appended to, created readable by you alone (`check` warns if not), rotated at 10 MB; `null` for none                                                                                                                        |
| `concurrency.reads`                                                             | `50`                                                                                                                                        | Concurrent GET requests to Asana (its limit)                                                                                                                                                                                                          |
| `concurrency.writes`                                                            | `15`                                                                                                                                        | Concurrent POST, PUT and DELETE requests (its limit)                                                                                                                                                                                                  |
| `retries.max`                                                                   | `5`                                                                                                                                         | Retries after a 429, or after a 5xx for anything but a POST, waiting as long as `Retry-After` says                                                                                                                                                    |
| `retries.maxWait`                                                               | `60s`                                                                                                                                       | The longest wait before a retry; a longer `Retry-After` is cut to it                                                                                                                                                                                  |
| `asana.enable`                                                                  | `[]`                                                                                                                                        | Flags sent in the `Asana-Enable` header of every request: `ai_teammate_actors` opts in to the early-access Agents endpoints, and an announced change's flag takes it before its date (see [Keeping up with Asana's API](#keeping-up-with-asanas-api)) |
| `asana.disable`                                                                 | `[]`                                                                                                                                        | Flags sent in the `Asana-Disable` header: an announced change kept off while Asana still allows it                                                                                                                                                    |
| `mcp.transport`, `mcp.host`, `mcp.port`, `mcp.allowedHosts`, `mcp.authTokenEnv` | `stdio`, `127.0.0.1`, `3845`, `[]`, `ASANA_GATE_MCP_TOKEN`                                                                                  | The defaults of `asana-gate mcp`                                                                                                                                                                                                                      |

A JSON Schema ships as `asana-gate/settings.schema.json`; `init` writes a `# yaml-language-server: $schema=…` pointer so editors validate the file.
Project settings are trusted like the project's code, which is why `token.command` is not honored from them.

### The token

The Personal Access Token is read from the first of these sources, and `asana-gate token status` says which one is in use (the token itself is never printed):

1. the environment variable named by `token.env` (`ASANA_ACCESS_TOKEN`);
2. the `token.command` of your own or managed settings;
3. the file named by `token.file`, else the project's `.asana-gate/token`, else `~/.asana-gate/token`.

`asana-gate token set` saves a token, typed unseen or piped in, to the file read first (`token.file` when set, else the project's `.asana-gate/token`) and lists that file in `.asana-gate/.gitignore` when it is inside `.asana-gate`; `asana-gate token set --user` saves it to `~/.asana-gate/token`.
The files are created readable by you alone, and `check` warns when one is not.
A token file in the project is what hosts without environment variables read, such as Claude Cowork (see [Agents](#agents)).

### Concurrency

The gate sends independent requests at the same time, up to Asana's own limits of 50 reads and 15 writes in flight per token (lower if `concurrency` says so): a page of tasks is checked with one lookup per task at once, the objects a write names are loaded together, and the actions of a `POST /batch` are planned together.
When Asana answers 429, the request waits the seconds its `Retry-After` header names (cut to `retries.maxWait`) and tries again, up to `retries.max` times, so running at the limit costs nothing but the wait; a 5xx is retried the same way after 1, 2, 4… seconds, or longer when its `Retry-After` asks, unless the request is a POST: Asana may have run it before failing, and a POST sent twice can create or add twice, so its 5xx is returned as it is.
An agent that needs many objects at once should send one `POST /batch` with up to ten actions rather than ten calls; the gate checks each action and Asana runs them as one request.

### Noticing failures

The gate degrades rather than stops when its own files fail: a log file that cannot be opened leaves warnings on stderr only.
Two things make a failure visible:

- the warning itself, on stderr and in the log file (`~/.asana-gate/logs/asana-gate.log` by default), where the MCP server's warnings land even when nobody watches its stderr;
- `asana-gate check`, which probes the log file, the token file's permissions and every object the policy names, and fails on what is broken.

## Keeping up with Asana's API

The repository holds structural snapshots of Asana's public OpenAPI definition: every operation with its parameters and body members ([`src/catalog/operations.gen.ts`](src/catalog/operations.gen.ts)) and every response schema as property names ([`src/catalog/schemas.gen.ts`](src/catalog/schemas.gen.ts)).
Wording is deliberately left out, so the snapshots change only when the API changes.

A weekly workflow refreshes them and opens a pull request whose description, produced by `scripts/openapi-report.ts`, lists the added, removed, changed and deprecated operations, the changed response fields, and what asana-gate must do about them.
CI fails on that pull request until every new operation is classified and every field the gate reads still exists; a new plain read, update or delete of one object is classified from its path, and the report lists it with its action to confirm.

Locally:

```sh
pnpm sync-openapi && pnpm format && node scripts/openapi-report.ts
```

The definition carries no wording, and some of what matters is written only on developers.asana.com: the opt-in flag of an early-access endpoint, a deprecation the definition does not mark, an access restriction.
A second weekly workflow reads the Markdown source of every page the site's index lists (`llms.txt`, then `<page>.md`) and lists, from the `updatedAt` of their front matter, the pages updated during the week, as a comment on one issue; `pnpm docs-updates` prints the list locally (`--days` widens the window).

Asana itself announces a change with an `Asana-Change` response header, which the gate logs once per change, and rolls it out over a period during which the `Asana-Enable` and `Asana-Disable` request headers choose the behaviour.
The `asana.enable` and `asana.disable` settings send those headers on every request, so a change can be taken early or kept off until its end date; `asana.enable` is also where an early-access opt-in goes, such as `ai_teammate_actors` for the Agents endpoints, which Asana refuses without it.

## Agents

A token an agent's shell can see is a token the agent can use without the gate.
Asana's own command line, `asana-cli` ([`@asana-api/cli`](https://developers.asana.com/docs/asana-cli)), is made for agents with a terminal: it reads `ASANA_ACCESS_TOKEN` by default and sends changes and deletions with no policy and no confirmation.
Which tool an agent reaches for is the agent's choice, steered by its instructions: tell it that Asana is reached only through asana-gate, as the paragraph `init --agent` prints does.
For an agent that keeps to them, that is enough, wherever the token is.
For the policy to hold against one that does not (a task or a comment may tell it otherwise), the token must be out of reach of the commands the agent runs, which Claude Code's sandbox can see to (below) and the other editors cannot.

### The skill

[`skills/asana-gate`](skills/asana-gate) is an [Agent Skill](https://agentskills.io) that teaches an agent how asana-gate answers, how to work through its tools and commands, and how to write a policy.
It is generated from this README and the tool definitions (`pnpm generate-skill`), and a test fails when the committed copy drifts.
`npx skills add sincekmori/asana-gate` installs it for the agents on your machine; Claude Code also reads the copy that `init --agent claude-code` puts in the project, and Claude Cowork takes it as a zipped upload under Customize > Skills.

### Claude Code

`asana-gate init --agent claude-code` makes a repository use the gate without anyone wiring it by hand:

- `.mcp.json` gains the project-scoped `asana-gate` server (`npx -y asana-gate@<this version> mcp`), which Claude Code asks each person to approve once;
- `.claude/skills/asana-gate` receives a copy of the skill, which Claude Code loads by itself; `check` warns when the copy is from another version;
- `.claude/settings.json` gains `Read(./.asana-gate/token)` and `Read(~/.asana-gate/token)` in `permissions.deny`, so the agent cannot read a token file (Claude Code applies the rules to `cat` and the other file-reading commands it recognizes), and the token's variable as a `deny` entry of `sandbox.credentials.envVars`: with Claude Code's sandbox on (`/sandbox`), the rules bind every command the agent runs, and the variable is taken out of their environment, while the MCP server, which runs outside the sandbox, still reads the token.
  An `asana-gate` command the agent runs in its shell then finds neither the token files nor the variable, so in such a project the agent works through the MCP tools.

Commit those with the policy, then say in `CLAUDE.md` what the command prints:

```markdown
## Asana

Tasks for this repository live in the Asana project "<project>", reached only through asana-gate:
the `asana-gate` MCP server in .mcp.json, governed by .asana-gate/policy.yaml.
Read .claude/skills/asana-gate/SKILL.md before touching Asana.
Never call the Asana API any other way (Asana's own `asana-cli` included), and never read .asana-gate/token.
```

Each person brings their own token, exported or saved with `asana-gate token set`, and the policy, reviewed like code, says what the agent may do with it.
The copy of the skill keeps itself current: whenever `asana-gate mcp` starts in the project with another version than the copy carries, it rewrites the copy, so an upgrade of the pin in `.mcp.json` shows up as a change to commit.
The Claude Code extension for VS Code reads the same `.mcp.json`.

### VS Code, Cursor and other agents

`asana-gate init --agent vscode` and `--agent cursor` (repeatable, and combinable with `claude-code`) do the same for those editors: the server goes into `.mcp.json`, which GitHub Copilot in VS Code reads as Claude Code and Copilot CLI do, or into `.cursor/mcp.json`, and the skill into `.agents/skills/asana-gate`, the cross-agent directory that VS Code, Cursor and Codex all read.
VS Code starts the server without asking once the workspace is trusted; `.vscode/mcp.json`, the file of its deprecated Local agent harness, is not written.
An existing file is changed only where the server goes, so its comments stay.
The command prints the paragraph for `.github/copilot-instructions.md` or `AGENTS.md`.
Neither editor can be told to keep its agent from reading a file or a variable, so with them the instructions the command prints are what keeps the agent to the gate, and the token is best kept out of the project, with `asana-gate token set --user` or in `ASANA_ACCESS_TOKEN`.
For Codex, the skill copy is enough on the file side; register the server with `codex mcp add asana-gate -- npx -y asana-gate@<version> mcp`.

### Hosts without MCP

Where an MCP server cannot be used, such as Claude Cowork under a policy that disables local servers, the skill works through the command line: every tool is an `asana-gate <resource> <verb>` command with the same inputs under the same policy.
Such a host sees only the folder it was given, so keep everything in it: `.asana-gate/policy.yaml` and `settings.yaml` as usual, and the token in `.asana-gate/token`, which `asana-gate token set` writes and `.gitignore` keeps out of git.
The commands need Node.js 24 or later and network access to `app.asana.com` (and to the npm registry when they run through `npx`); `asana-gate check` from the folder confirms all of it in one go.

## Notes from live verification

asana-gate was exercised against the real API.
Some behaviors worth knowing:

- Asana's 404 for a well-formed unknown gid is `task: Not a recognized ID: …`; asana-gate uses the same wording for invisible objects.
- `POST /tasks` needs `projects`, `parent` or `workspace`; `memberships` alone is rejected, so the `asana_create_task` tool sends `projects` together with `memberships` when a section is given.
- `POST /sections/{gid}/addTask` adds a task from another project to the section's project; asana-gate therefore requires `task:create` there as well as `task:move`.
- A task's `parent` cannot be changed through `PUT /tasks/{gid}`; use `setParent`.
- `PUT /sections/{gid}` changes a section's name alone: it requires `name`, and answers 200 to `insert_before` or `insert_after` without moving the section, so moving one is `POST /projects/{gid}/sections/insert` and `section:reorder`.
- `POST /sections/{gid}/addTask` on a subtask that has no project of its own (it shows in its parent's project) makes it a member of the section's project, so asana-gate requires `task:create` for it too.
- A custom field defined in place on a project is local to it (`is_global_to_workspace: false`) and is gone once taken off again; one defined in place on a table becomes a field of the workspace's library, and a goal refuses one ("Cannot add non-global custom fields to this object.").
- `POST /projects/{gid}/saveAsTemplate` needs `team` (or `workspace` outside an organization), and the template lives in that team.
- A goal created through `POST /goals` is `public_to_workspace`, as the request has no privacy member, and in the organization tried it needed a `time_period`.
- Creating, updating or deleting budgets and rates answered that it needs the timesheets and budgets add-on, in a paid organization without it.
- Batch actions carry query parameters in `data`, not in `relative_path`.
- The Search API, custom fields, portfolios, goals, task dependencies, milestones, and tables and records are unavailable on free workspaces (402); the gate passes such responses through.
- `POST /projects/{gid}/removeMembers` refuses `me`, which `addMembers` takes, so `asana_remove_project_members` wants gids.
- Removing a project's owner from its members leaves the project without an owner, and added back the user is an editor, who can neither take the ownership back nor delete the project.
- Unknown `opt_fields` are ignored by Asana, so the fields the gate adds to requests never break them.
- With `opt_fields`, Asana answers the `gid` and the selected members only: a reference selected alone comes back as `{ gid, resource_type }`, and one with a selection inside it (`parent.name`) as `{ gid, name }`, without its `resource_type`.
  The gate therefore also selects `resource_type` inside every member its fields reach into, to recognize and check nested references, and cuts every object back to the caller's fields before answering.
  In a list or in the answer to a write, a member the caller selects alone and the gate reads inside (`parent` in a list of tasks) keeps what the gate selected inside it, because selecting inside a member changes what Asana answers for it; a `GET` by gid reads what the gate needs beside the request instead.
- Nested selections reach into referenced objects, including on typeahead results: `memberships.project.team` gives a task's team with the task.
  They reach any member of such an object (`memberships.project.notes`, and `resource.notes` on an event), so the gate checks and redacts a reference wherever an answer nests it.
- A `reference` custom field takes one gid or a list of them, of objects of the types its `input_restrictions` name (Asana answers that member for such a field only), and refuses a gid that names nothing with a 400 (`reference_value: [0]: Unknown object: …`), and an object of another type with a different one.
  It answers each object with its `gid`, `resource_type` and `name` and no other member, whatever is selected inside `reference_value`, and names them all in `display_value` (`null` for none).
- A project holds its latest status update twice: compact in `current_status_update`, and whole, its text included, in the deprecated `current_status`, under the type `project_status` and the same gid.
  A notification names its story as `{ gid, resource_type }`; `story.text` is honoured there and `story.target` is not, so the gate reads the story to learn what it is on.
- Custom fields, custom types, time periods, time tracking categories and out-of-office entries carry no `workspace` member, so the gate places them in the governed workspace; with a token that belongs to several workspaces, rules at workspace level also govern such objects of the other workspaces when an agent names their gids. `PUT /enum_options/{gid}` is checked at workspace level only (Asana offers no way to read an enum option).

## Library

The package also exports the building blocks for other hosts.

```ts
import { AsanaClient, Gate, loadPolicyFile, policyFor } from "asana-gate";

const client = new AsanaClient({ token: process.env.ASANA_ACCESS_TOKEN ?? "" });
const file = await loadPolicyFile("asana-gate.yaml");
// All a policy asks of Asana: who the token belongs to, and what its workspace is called.
const policy = await policyFor(client, [{ file, path: "asana-gate.yaml", role: "project" }]);
const gate = new Gate({ client, policy });

const response = await gate.execute({
  method: "GET",
  path: "/projects/1200000000000123/tasks",
  query: { limit: "20" },
});
// response.status, response.body — shaped exactly like Asana's, filtered and decorated with allowed_actions
```

`loadSettings({ cwd, env })` reads the same layered settings the command line uses.
JSON Schemas for policy and settings files ship as `asana-gate/schema.json` and `asana-gate/settings.schema.json`; point `"$schema"` at them for editor validation.

## Development

```sh
pnpm install
pnpm build          # tsdown (incl. publint + attw)
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint --type-aware
pnpm format         # oxfmt --write .
pnpm sync-openapi   # refresh the OpenAPI snapshots
pnpm docs-updates   # list the pages of developers.asana.com updated in the last week
pnpm generate-schema # regenerate schema.json and settings.schema.json
pnpm generate-skill  # regenerate the skill from the README and the tool definitions
pnpm generate-server # regenerate server.json, the MCP Registry entry
```

Versioning and publishing use [Changesets](https://github.com/changesets/changesets): `pnpm changeset` describes a change, and merging to `main` opens a Version Packages PR that publishes to npm when merged.

## License

[Apache-2.0](LICENSE)
