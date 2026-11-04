---
name: asana-gate
description: >-
  {{DESCRIPTION}}
license: Apache-2.0
metadata:
  version: "{{VERSION}}"
---

# asana-gate

asana-gate is a policy gateway in front of the Asana REST API.
A YAML policy says, per scope (workspace, team, portfolio, project, section, task), which actions an agent may take and how its requests are shaped; the gate enforces it on every request, whether it arrives as an MCP tool call or as an `asana-gate` command.
Everything you can see or do through it is decided by that policy, not by Asana: objects the policy hides do not exist for you, and refusals come back as HTTP-style errors whose message starts with `asana-gate:`.

## Read the gate's answers first

Every object the gate returns carries `allowed_actions`: the `<resource>:<verb>` actions the policy allows on it right now, such as `task:update` or `story:create`.
Check it before writing, because an action missing from it will be refused: plan around what is listed rather than trying and failing.

| Answer                                                                                     | Meaning                                                                                                                                         | What to do                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404` `<type>: Not a recognized ID: <gid>`                                                 | The object does not exist, or the policy hides it; the gate deliberately makes the two indistinguishable (the same 404 Asana sends)             | Do not retry or try other gids. Say the object is not visible under the policy; its owner can run `asana-gate explain <gid>` to see which rule hides it |
| `403` `asana-gate: <action> is not permitted on <type> <gid>`                              | The object is visible, but the policy does not allow this action there                                                                          | Report it and offer an action from `allowed_actions`; widening the policy is the owner's call                                                           |
| `403` `asana-gate: updating <resource>.<member> is not permitted here (allowed fields: …)` | The update touched a member outside the rule's `fields` allowlist                                                                               | Resend with only the allowed members                                                                                                                    |
| `400` `asana-gate: the <resource> does not satisfy the policy: …`                          | A constraint of the policy: a required member is missing or cleared, a prefix or format is wrong, a value is not allowed, a member is forbidden | Fix the request exactly as the message says and resend                                                                                                  |
| `428` `asana-gate: <action> needs a person's confirmation`                                 | The policy wants a human to approve this action                                                                                                 | Over MCP, answer the elicitation the client shows; from a shell, rerun with `--yes`                                                                     |
| `429` `asana-gate: <action> is limited to N per <period>`                                  | A rate cap the policy sets on this action in this scope                                                                                         | Wait for the period to pass; do not loop on it                                                                                                          |

Lists (projects, tasks, search, typeahead, events) are filtered silently: hidden objects are simply absent, nothing says how many were removed, and a page carries `next_page.offset` to continue with `offset`.
Asana's own errors pass through unchanged, without the `asana-gate:` prefix: a 402 means the workspace's plan lacks the feature (search, custom fields, portfolios and goals need a paid plan), a plain 400 is Asana rejecting the body, a plain 403 is the token's own permission (audit log events, workspace events and organization exports take a service account on an Enterprise tier; the early-access Agents endpoints take the `ai_teammate_actors` flag in the settings' `asana.enable`).
Look for the prefix: with it the policy decided, without it Asana did.

## Working through MCP

The server exposes the curated tools the policy could ever allow, plus three generic ones:

- `asana_create_tasks` and `asana_update_tasks` take up to {{BATCH_LIMIT}} tasks at once and answer with one `status_code` and `body` per task, in order; some may fail while the others succeed.
- `asana_request` calls any Asana REST operation (`method`, `path` below `/api/1.0`, `query`, `body` as the `data` object) through the same policy; a `POST /batch` through it takes up to {{BATCH_LIMIT}} actions.
- `asana_operations` lists the operations with the policy action each needs; `asana_allowed_actions` tells what you may do with one object.

{{TOOLS_TABLE}}

To read many objects at once, send one `POST /batch` through `asana_request` with up to ten actions (`{"actions": [{"method": "get", "relative_path": "/tasks/123"}, …]}`): the gate checks each action and Asana runs them as one request, which beats ten sequential calls.
When a tool call comes back as an elicitation (a confirmation request) the policy wants a person to approve the action: present it to the user and resend only when they accept.
The full tool reference, with every input member and its command-line form, is in [references/tools.md](references/tools.md).

## Working from a shell

Every curated tool is also a command with the same inputs and the same policy:

```sh
asana-gate task list --project 1200000000000123 --completed-since now   # open tasks
asana-gate task create --name "Write docs" --projects 1200000000000123 --due-on 2026-12-01
asana-gate task update 1200000000000456 --assignee me --completed
asana-gate task move 1200000000000456 --section 1200000000000789
asana-gate task comment 1200000000000456 --text "Done, see the attached diff."
asana-gate task delete 1200000000000456 --yes                            # confirms non-interactively
asana-gate task create-many --tasks @tasks.json                          # up to {{BATCH_LIMIT}} at once; also inline JSON or - for stdin
asana-gate find design --type project
asana-gate api GET /tasks/1200000000000456 -q opt_fields=name,completed
asana-gate api POST /tasks -d '{"name": "Write docs", "projects": ["1200000000000123"]}'
```

- The object a verb acts on is a positional argument; everything else is a flag named after the API member (`--due-on` for `due_on`).
  Booleans are switches (`--completed`, `--no-completed`), lists take comma-separated values, `--custom-fields` and `--tasks` take JSON (inline, `@file` or `-`), and `null` clears a member that allows it.
- `--json` prints the response as Asana returns it (the `api` command always does); otherwise lists print as tables and objects as `key: value` lines.
- Exit codes: 0 success, 1 the policy or Asana refused (the message is on stderr), 2 usage error.
- `asana-gate <resource> --help` lists the verbs, `asana-gate <resource> <verb> --help` the flags.
- `asana-gate api <METHOD> <path> [-q key=value] [-d json|@file|-]` reaches every operation; `asana-gate explain <gid>` shows how the policy treats one object (it reads Asana unrestricted, so it is for policy owners, not agents).

A project keeps its policy and settings in `.asana-gate/` (`policy.yaml`, `settings.yaml`, personal `settings.local.yaml`, and the git-ignored `token`); `~/.asana-gate/` holds your defaults, token, cache and logs; an administrator's managed settings override everything.
A `~/.asana-gate/policy.yaml` and an administrator's `managed-policy.yaml`, when present, bound the project's policy: an action is allowed only when every file allows it, so a file that does not mention an action denies it.
Commands find `.asana-gate` by walking up from the working directory; `-C <dir>` runs a command as if started in `<dir>`.
The token comes from `ASANA_ACCESS_TOKEN`, else the `token.command` of the user's settings, else `.asana-gate/token` in the project or `~/.asana-gate/token`; it is never printed, and `asana-gate token status` says which source is in use.
`asana-gate init` creates the project directory (`--agent claude-code` also wires Claude Code), `asana-gate check` validates the settings, the token and every object the policy names against Asana (exit code 1 on a problem), `asana-gate settings` shows the values in force and where each comes from, and `asana-gate cache` shows or clears the on-disk cache of workspace names.
In a host without MCP (Claude Cowork, for example) work from the folder that holds `.asana-gate` with these commands, and run `asana-gate check` first: it tells in one go whether Node, the network, the token and the policy are all in place.
Details: [references/cli.md](references/cli.md).

## Writing or changing a policy

A policy names one workspace and lists rules; their order does not matter.

```yaml
version: 1
workspace: "1200000000000001" # a gid or a name
rules:
  - allow: [read] # no `where`: the whole workspace
  - where: { project: "Mobile App" }
    allow: ["task:*", story:create, tag:apply]
  - where: { project: "Mobile App", section: "Done" }
    deny: [modify] # frozen but still visible; deny: ["*"] would hide it
  - where: { project: "Mobile App" } # constraints: what requests must look like
    require: { task: { due_on: true } }
    apply: { task: { name: { prefix: "[bot] " } } }
    confirm: [task:delete]
    limit: { "task:create": { max: 20, per: 1h } }
```

How a request is decided:

1. **Scope.** `where` keys: `team`, `portfolio`, `project`, `section` (named inside its `project`), `subtree` (a task gid and all its subtasks), `task` (a gid), `unhomed: true` (tasks in no project); the filters `tag`, `assignee` (`me`, a gid or an email) and `custom_field: { Name: value }`; and the state filters `created_by`, `completed`, `has_parent`, `name: { prefix | suffix | contains | matches }`, `overdue`, `due_within`, `created_within`.
   Keys in one `where` are ANDed, and a name is resolved against Asana when the policy loads, so an unknown name is an error rather than a silent no-match.
2. **Actions.** `<resource>:<verb>` such as `task:update`; the groups `read`, `modify` (every verb but read), `write` (read plus every creating and modifying verb) and `admin` (everything); the wildcards `task:*` and `*:delete`.
   `read` is the prerequisite of every verb: an object whose `read` is not allowed is invisible, whatever else a rule says.
   Updating `completed` needs `task:complete`, `assignee` needs `task:assign`, a project's `archived` needs `project:archive`; other members need `update`.
   Explicit-only actions never come from a group or a wildcard and must be written out to be allowed: `webhook:create`, `webhook:update`, `export:create`, `organization_export:create`, `organization_export:read`, `audit_log:read`; in `deny`, `confirm` and `limit` a group or wildcard does cover them.
3. **Which rule wins.** The most specific scope decides (task, then subtree, section, project, then team, portfolio or unhomed, then workspace), then the rule with more filters; at equal specificity `deny` wins; no matching rule means deny.
   Filters never make an object visible on their own: they widen or narrow what may be done with objects another rule already lets the agent read, and they can hide (`deny: [task:read]`).
   A rule takes part only for the actions it names, so a read-only scope is `allow: [read]` plus `deny: [modify]`: the deny keeps a broader `allow` elsewhere from reaching it, while `deny: ["*"]` would also deny read and hide the objects.
   A task in several projects must be allowed in every one of them, and a subtask takes the placement of its nearest ancestor that has one.
   When several policy files are in force, every file must allow an action, each by its own rules (see "Several policies" in [references/policy.md](references/policy.md)).
4. **Constraints** shape the requests made in a rule's scope and may stand alone, without `allow`: `require` (per resource and member, `true` for "must be present", or operators `prefix`, `suffix`, `contains`, `matches`, `not_matches`, `in`, `not_in`, `min_length`, `max_length`, `min`, `max`), `apply` (a bare default value, or `default`, `value`, `prefix`, `suffix`, `add`), `forbid` (members that may not be set), `redact` (members removed from responses), `limit` (`max` per `per`, such as `1h`), `confirm` (actions a person must approve).
   `apply` runs before `require`, so a prefix one rule adds satisfies the prefix another requires; every matching rule's `require` holds, the most specific rule's `apply` wins per member, and `forbid`, `redact` and `confirm` add up.
   Custom fields nest by name: `require: { task: { custom_fields: { Owner: { in: [AI] } } } }`.
5. **`fields`** on an `allow` rule limits updates to the listed members: `allow: [read]` with `fields: { task: [completed, due_on] }` lets the agent update only those two (and complete, which `completed` stands for).

Workflow: `asana-gate init` writes `.asana-gate/policy.yaml` from the workspace (its teams and projects listed as comments to start from), then edit it, then `asana-gate check` (resolves every name, warns about rules that cannot work, confirms the token), then `asana-gate explain <gid>` to see which rule decides each action on one object and which constraints are in force.
The full reference, every key and value included, is in [references/policy.md](references/policy.md); the MCP server's transports and confirmation flow are in [references/mcp.md](references/mcp.md).

## Resources and verbs

{{RESOURCE_TABLE}}
