---
"@rivi-software/deploy-watch": patch
---

A reload that does not happen no longer leaves the tab stuck. When the user stayed at the page's unsaved-work prompt, or the back/forward cache brought the page back, the tab took itself as reloading for the rest of its life: the notice's Reload did nothing, `followNewBuild` never reloaded again, `isReloadingOntoNewBuild()` stayed true so errors went unreported, and an error screen behind `useChunkErrorRecovery` stayed blank. Now the first key or pointer press after a reload started, or the restore from the back/forward cache, ends it: the tab can reload again, errors are reported again, and the error screen shows its error. `subscribeToReload(listener)` tells an error screen of your own when that happens.
