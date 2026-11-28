---
"asana-gate": minor
---

`asana-gate check` now checks every object a policy names, wherever a rule names it: the tags, users, projects, teams and custom fields of `require` and `apply`, beside those of `where`.
It also checks that each custom field can hold the values a rule writes for it: an option of an enum field, whose options it lists with their gids, a user of a people field, an object of a type a reference field takes.
