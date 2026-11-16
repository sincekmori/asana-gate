---
"asana-gate": minor
---

The dedicated tools and commands now cover what Asana's own MCP server offers, apart from its status overview and its interactive previews: the followers and dependents of a task, the members, custom fields and task counts of a project, the teams of a user, task and project templates, Inbox notifications, AI Teammates, tables and records.
The tools that were there take more of Asana's members: more filters in `asana_search_tasks` and `asana_list_task_stories`, `resource_subtype` and `approval_status` on a new task, `assignee_section` on tasks, `privacy_setting`, `default_access_level`, `default_view`, `owner`, `icon` and custom field values on projects, and AI Teammates in `asana_typeahead`.
A tool called with an argument its input does not declare now refuses the call and names the argument, where it used to drop the argument and run without it: `asana_create_comment` given `parent_comment` posted a top-level comment.
Send such a member through `asana_request`, which takes every member of an operation.
`asana_get_task` answers the task's latest comments and its direct subtasks in the same call when asked (`include_comments`, `comment_limit`, `include_subtasks`), and `asana_get_project` its sections and task counts (`include_sections`, `include_task_counts`); a part that is refused is `null`.
Two requests that passed on less than they do are now held to it: the `approval_status` of an approval task, which completes or reopens the task, needs `task:complete` like `completed` (and a new approval task in a status other than pending counts as completed where a rule filters on `completed`), and a custom field defined in place while it is put on a project, a portfolio, a goal or a table needs `custom_field:create` in the workspace and is shaped by the constraints on `custom_field`.
Both passed through `asana_request` before; a policy that relied on either must now grant the action.
