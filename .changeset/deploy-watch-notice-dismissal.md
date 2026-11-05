---
"@rivi-software/deploy-watch": minor
---

The new-version notice shows again for a later deploy after a dismissal. Before, `useNewBuildNotice().dismiss` set a flag in that one component, so a dismissed notice stayed hidden for every later deploy, even one that changed the module on screen again, and a notice that mounted again showed again for the build it was dismissed for. The tab now remembers what was dismissed, and every notice reads it: the live build, or with `{ module }`, that module's fingerprint in it. The notice shows again once a later build is live with other browser code, or with `{ module }`, once a later build changes that module again. `dismissNewBuildNotice(module?)` and `isNewBuildNoticeDismissed(module?)` do the same for a notice that is not React's, and `subscribeToNewBuild` listeners hear of a dismissal.
