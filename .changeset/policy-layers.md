---
"asana-gate": minor
---

The policy in force is now made of up to three files: the project's policy (or the file `--policy` points at), your own `~/.asana-gate/policy.yaml` and an administrator's `managed-policy.yaml`.
Every file that exists is read, and an action is allowed only when every file allows it, each by its own rules and its own default of deny; constraints add up across files, `fields` allowlists intersect, and the stronger file's `apply` wins a tie.
A file other than the project's may leave `workspace` out; one that names another workspace is not in force there, which `check` reports.
`check` lists every file in force, and messages name a rule by its file when there are several (`user rules[2]`).
