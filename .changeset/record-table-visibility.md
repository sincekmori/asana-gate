---
"asana-gate": patch
---

Creating a record now needs the table it goes into to be visible to the policy, and a record search may filter only by tables and teams the policy shows, like every other object a request names (a policy without `table:read` could put records into any table, verified live).
