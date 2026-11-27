---
"asana-gate": patch
---

The objects an event or a notification names are now shown as the policy says, like any other reference: `resource.notes` on `GET /events` read a task's redacted notes (verified live).
Both are now judged whatever fields a request selects: the gate asks for an event's `action`, `resource` and `parent` and a notification's `work_objects` beside the caller's fields and cuts the answer back to those, where an event of a hidden task used to pass once `opt_fields` left its `resource` out (verified live), and the event of a deleted object to go once they left its `parent` out.
