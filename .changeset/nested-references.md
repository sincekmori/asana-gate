---
"asana-gate": patch
---

An object the policy hides is now removed wherever an answer nests it, and a visible one redacted as the place it lives in says, where both used to hold only for the tasks, projects, sections, portfolios, goals and teams an object carries directly.
A project and a section named by a task's `memberships` and the values of a `reference` custom field passed unchecked, so `memberships.project.notes` read a project's redacted notes, a task of a policy that allows tasks alone showed the project it is in, and a reference custom field showed the name of a hidden task (verified live).
So did an object that lives inside another: a project showed its latest status update, text included, whatever the policy says about status updates there, and a notification the text of its story (verified live).
An object that lives at workspace level, such as a task's assignee, still stays where a visible object names it, and now loses the members the policy redacts.
A `reference` custom field that loses a value now answers `display_value: null`, since Asana's text for the field names every object it holds, and the gate asks for the references beside that text when a request selects the text alone.
An answer costs a request for each project, section, status update or story it shows that the gate has not loaded already, unless the answer itself carries what the object lives in; nothing is loaded for a member the answer leaves out.
