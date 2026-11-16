---
"asana-gate": patch
---

An `in` or `not_in` requirement now admits only the values Asana takes, the gids of the options, tags, projects and teams the policy names (users still by `me` or an email as well), where it used to pass their names on to a refusal from Asana (verified live); its refusal lists each value with its gid, and `asana-gate explain` shows such sets and patterns instead of `{}`.
