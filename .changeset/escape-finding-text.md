---
"@rivi-software/semgrep-github-report": patch
---

The comment and the job summary show a finding's path, rule ID and message as written. A `|` or a line break in a path no longer splits its table row, and a backtick no longer ends a code span early. In a message, an invisible zero-width joiner keeps an `@` mention from notifying anyone, HTML such as `<!--` from hiding the rest of the comment, and a code fence from turning it into code. Links and email addresses in a message keep working.
