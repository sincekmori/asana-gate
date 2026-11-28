---
"asana-gate": minor
---

A policy now names every object by its gid, in quotes, and a name is refused when the policy loads: a name tells no object from another, since two projects may share one and whoever renames an object would decide what a rule covers.
This goes for the workspace, for every `where` key, for the fields under `custom_fields` and for the values of the members that name objects (`tags`, `projects`, `team`, `assignee`, `followers`, `owner`); a user may still be `me`, and no longer an email.
A `custom_field` scope matches a field by the gid of what it holds (an option, a user, another object), where an option's name used to match too, and by the text Asana displays when it holds none.
A refusal lists the gids a member may take (`custom_fields.<gid> must be one of <gid>`).
Reading a policy now asks Asana who the token belongs to and what the workspace is called, and nothing else, so the on-disk cache of the workspace's names is gone with everything that served it: the `cache` settings, `ASANA_GATE_CACHE`, the `asana-gate cache` command, and `AsanaNameResolver` and `FileListingCache` in the library, where `policyFor(client, sources)` now compiles a policy for a client.
The directory `~/.asana-gate/cache` is no longer read and can be deleted.
`asana-gate init --workspace` takes a gid.
