---
"asana-gate": patch
---

A custom field that a request puts on or takes off a project, a portfolio, a goal or a table by gid must now be visible to the policy, like any other object a request names: without `custom_field:read` the request answers 404 where it used to pass.
