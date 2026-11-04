---
tags: [asana-gate]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

We use asana-gate in this repo. Write the policy file at .asana-gate/policy.yaml for workspace gid 1200000000000001 so that our agent can read everything in the workspace, do full task work (create, update, complete, comment) only in the project 'Mobile App' (gid 1200000000000123) but nothing in that project's 'Done' section, must put the prefix '[bot] ' on every task it creates there and must give each one a due date, and needs a person's confirmation before deleting any task. Save the file and tell me how to validate it.
