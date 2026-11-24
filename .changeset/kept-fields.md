---
"asana-gate": minor
---

Every object is now answered with the fields the request asked for, as a `GET` by gid already was: the members the gate reads beside them to judge an object (a task's `workspace`, `parent` and `memberships`, a project's `team`) no longer come back in the items of a list or in the answer to a write that names `opt_fields`.
The items of a list asked for without `opt_fields` carry their `gid` and name (or what tells apart an object that has no name) and their `allowed_actions`, so ask for the members you need: a caller that read `memberships` or `parent` off a list without asking for them must now name them.
Nothing is loaded from Asana any more to check a member the answer leaves out: a list of projects, for one, no longer costs a request per team its projects are in.
