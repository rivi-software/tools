---
"@rivi-software/semgrep-github-report": patch
---

`--mode pr` now updates only a comment that opens with `<!-- semgrep-scan -->` and that `github-actions[bot]` wrote, or the account the new `--author <login>` option names. Any other comment with the marker is left alone, and the command comments anew when none matches. Before, it updated the first comment that held the marker anywhere, so a person's comment that pasted or quoted the report, posted before the report's own, was the one it edited: GitHub refused the edit with a 403 on every run, or, with a token that could edit it, the command overwrote that person's comment. A workflow that runs the command with a GitHub App's or a person's token passes that account's login, such as `--author acme-scanner[bot]`. Without it, such a run adds a comment every time.
