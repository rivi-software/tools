---
"@rivi-software/deploy-watch": minor
---

A tab now reads `/build.json` when the browser comes back online, even less than a minute after a read that got no answer. Before, the minute between checks counted from that failed read too, so coming back online soon after it checked nothing, and a deploy that went live meanwhile showed no notice and gave no whole-page load at the next move until the tab got focus, came back into view or reached its ten-minute check. Coming back online after a read that did get an answer still waits for the minute, and a burst of events still shares one request.
