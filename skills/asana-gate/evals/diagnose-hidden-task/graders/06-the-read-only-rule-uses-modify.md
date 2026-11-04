---
type: llm
focus: trace
weight: 1
---

The proposed read-only rule keeps the tasks visible and blocks writes with the modify group (allow: [read] with deny: [modify]) or with explicit write denies, rather than a deny that also covers read
