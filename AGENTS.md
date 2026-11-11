# Notes for agents and contributors

Conventions the tooling does not enforce.

- Markdown files put one sentence per line.
- A commit message is one sentence on one line.
- Generated files are not edited by hand: `skills/asana-gate/SKILL.md` and `skills/asana-gate/references/` come from `scripts/skill/SKILL.template.md`, the README and the tool definitions through `pnpm generate-skill` (a test fails when they drift), `schema.json` and `settings.schema.json` from the zod schemas through `pnpm generate-schema`, `server.json` from `package.json` through `pnpm generate-server`, and `src/catalog/*.gen.ts` from Asana's OpenAPI spec through `pnpm sync-openapi`.
