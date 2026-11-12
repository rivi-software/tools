---
"@rivi-software/semgrep-github-report": minor
---

`--mode pr` now lists the findings of a pull request from a fork in the job summary, as `--mode summary` does, prints a line that says why and exits 0. It tells a fork apart by the event in `GITHUB_EVENT_PATH`: the pull request's head repository is not `GITHUB_REPOSITORY`. It makes no request to GitHub then, since GitHub gives a fork's pull request a read-only `GITHUB_TOKEN`. Before, the step failed with a 403 on every pull request from a fork, unless the workflow skipped it with a step condition. Those conditions can go: `if: github.event_name == 'pull_request'` on the step is enough. A 403 on a pull request from the repository itself still fails the step, and now names only the missing `pull-requests: write`.
