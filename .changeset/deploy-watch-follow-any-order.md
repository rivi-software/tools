---
"@rivi-software/deploy-watch": minor
---

`followNewBuild(router)` follows the router whether `startDeployWatch()` runs before or after it. Before, called first, it returned a no-op and never followed, with no warning, so every tab stayed on the old build at its moves to another page until a chunk failed. In TanStack Start, where `getRouter()` and the client entry's `startDeployWatch()` sit in different files, that order was easy to get wrong. Now it subscribes in the browser at once and asks the watch that runs at each move. On the server it still does nothing, so the `typeof window` guard around it is no longer needed.
