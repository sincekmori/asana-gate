---
"asana-gate": patch
---

The package no longer ships source maps, which made up most of its size; the bundled files are unminified, so stack traces stay readable without them.
