---
"asana-gate": patch
---

`init --agent vscode` now puts the server into `.mcp.json`, which GitHub Copilot in VS Code reads as Claude Code and Copilot CLI do, instead of `.vscode/mcp.json`, the file of the Local agent harness that VS Code has deprecated.
Naming `claude-code` and `vscode` together writes that one file once.
An entry an earlier version left in `.vscode/mcp.json` is no longer updated or checked: delete it, because VS Code still forwards that file to Copilot.
