---
"asana-gate": patch
---

`init --agent claude-code` now also denies reading the token file in the home directory and lists the token's variable under `sandbox.credentials.envVars`: with Claude Code's sandbox on, no command the agent runs finds the token files or the variable, `asana-gate` in its shell included, while the MCP server still reads the token.
The README now tells the two apart: instructions keep an agent that follows them to the gate wherever the token is, and only a token out of the agent's reach makes the policy hold against one that does not.
