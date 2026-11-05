---
"@rivi-software/deploy-watch": patch
---

`useChunkErrorRecovery(error)` checks each error an error screen renders. Before, it decided on the first render only, so a screen that stayed mounted while its error changed kept that first answer: a chunk error after another kind of error showed instead of reloading the page, and so did a chunk error after one whose check had shown the screen. Now another error starts the check over, and a check still running for an earlier error no longer decides for the new one.
