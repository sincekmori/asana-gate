---
tags: [asana-gate]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I'm writing a shell script around the asana-gate CLI. It should: (1) list the open (not completed) tasks of project 1200000000000123 that are assigned to me, as JSON; (2) move task 1200000000000456 into section 1200000000000789 without any interactive prompt, even if the policy asks for confirmation; (3) rename that task to 'fix login'. Our policy has `require: { task: { name: { prefix: "[bot] " } } }` on that project and no apply rule. Give me the exact commands, and tell me what the gate will answer for step 3 and why.
