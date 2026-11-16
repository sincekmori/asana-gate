---
"asana-gate": patch
---

`PUT /sections/{gid}` needs `section:update` alone again, also when it carries `insert_before` or `insert_after`: Asana changes only a section's name there and leaves the order as it was (verified live), so asking for `section:reorder` refused renames that moved nothing.
