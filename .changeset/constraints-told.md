---
"asana-gate": minor
---

`asana_allowed_actions` now also tells the constraints in force where the object is, as `constraints`, so an agent can write a request that fits instead of learning each constraint from a refusal: per resource and member what a create or update must carry (`require`) or may not set (`forbid`), what the policy fills in (`apply`) or leaves out of answers (`redact`), and per action the caps (`limit`) and the confirmations (`confirm`), each value with the gid to send.
The operators read as a policy writes them, which `asana-gate explain` now does too (`not_in` where it printed `notIn`).
