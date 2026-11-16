---
"asana-gate": patch
---

Taking a local custom field (one outside the workspace's library, such as a field defined in place on a project) off a project, a portfolio, a goal or a table now needs `custom_field:delete` as well as `custom_field_setting:delete`, because Asana deletes such a field with its setting (verified live), and the README now says that project templates follow their team rather than a project.
