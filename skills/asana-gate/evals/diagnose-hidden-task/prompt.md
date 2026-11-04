---
tags: [asana-gate]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Our agent calls the asana_get_task MCP tool (served by asana-gate) for task 1200000000000456 and gets back {"errors":[{"message":"task: Not a recognized ID: 1200000000000456"}]}. I can open that task in Asana myself; it is in the project 'Payroll' (gid 1200000000000999). Here is our policy:

```yaml
version: 1
workspace: "1200000000000001"
rules:
  - where: { project: "1200000000000123" }
    allow: [read, "task:*"]
  - where: { project: "1200000000000999" }
    deny: ["*"]
```

What is happening, and what exactly should I change if the agent should be able to read (but never edit) tasks in Payroll?
