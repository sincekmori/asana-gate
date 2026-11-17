---
"asana-gate": patch
---

The instructions `asana-gate init --agent` prints now name Asana's own `asana-cli` among the ways an agent must not reach Asana, and the README and the skill say not to export the token where an agent runs commands, since `asana-cli`, which Asana announced for agents on 2026-11-13, reads `ASANA_ACCESS_TOKEN` by default and sends every request without a policy.
