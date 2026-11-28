---
"asana-gate": minor
---

The gate now judges every request by what Asana says while it runs: it keeps nothing of Asana's answers between requests, where the MCP server used to keep where an object lives for half a minute, a project's team and the contents of a portfolio for five.
A task somebody moves out of a project, a project moved to another team and a project taken out of a portfolio are judged where they are from the next request on.
Within a request the gate still asks for each thing once, and once the request has written it asks again for what judges the answer.
A request therefore costs a read for each object it must place, where a running server used to answer some from memory: about one more request to Asana per operation, and a listing of each portfolio the policy names per request.
The project and the section a task is in are now judged by what placed the task, without a request for either, in a single object and in every item of a list.
In the library, `Gate` takes no `loader` and has none: each request gets a `FactsLoader` of its own, whose `objectTtlMs`, `projectTtlMs` and `portfolioTtlMs` options and `invalidate` method are gone.
