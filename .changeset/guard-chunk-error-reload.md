---
"@rivi-software/deploy-watch": patch
---

An error screen that caught a missing chunk now reloads onto a newer build only once the tab has written its loop guard to session storage. Where the browser refuses session storage, such as Safari with site data blocked or some embedded web views, `recoverFromChunkError(error)` resolves `false` and `useChunkErrorRecovery(error)` shows the error. Before, the screen reloaded without the guard. On a host that served the old page after the assets moved on, the tab came back on the old build, found the newer one again at the next failed chunk and reloaded again, with nobody touching it. A reload from the notice, and the whole-page load at a move to another page, still happen without storage. Nothing changes where session storage works.
