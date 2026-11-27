---
"asana-gate": patch
---

A create or an update that sets a `reference` custom field to an object the policy hides is now refused with the 404 of a gid that names nothing, like every other request that names a hidden object: it used to reach Asana, whose answer told a hidden object (accepted, or refused for its type) from one that does not exist (verified live).
To tell such a field from any other, the gate reads the definition of each custom field a request sets, once per half minute.
A hidden object among several types a request may name (the item of a portfolio, the resource of a goal relationship) now answers with the same message as one that does not exist, where the message used to name the hidden object's type.
