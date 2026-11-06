---
"asana-gate": minor
---

The MCP server's instructions now tell the agent whom every request runs as: the gid of the token's user and the name and gid of the workspace, plus the user's name and email as far as the policy would show them through `GET /users/me`.
