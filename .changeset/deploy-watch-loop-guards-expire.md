---
"@rivi-software/deploy-watch": minor
---

The loop guards in a tab's session storage now hold for ten minutes (`LOOP_GUARD_MS`) instead of the whole session. Before, a reload onto a new build that landed on a page of the old build, such as one a cache still served for a minute after the deploy, left that build never new to the tab again: hours later, with the cache long expired, the tab still ran the old build, with no notice and no whole-page load at its next move, until another deploy. And a chunk of the live build that failed (a dropped connection) reloaded the page once per build in the whole session, so a second dropped connection hours later showed the error screen, though a reload would have fixed it.

Each guard now stores the time with the build id, and a later check tries the reload again once the guard is ten minutes old. A reload loop takes seconds, so the guards still stop one, and a cache that serves the old page for longer costs at most one reload in ten minutes. A bare build id, as earlier versions wrote it, holds for ten minutes from when the page loaded, so tabs open across the upgrade keep their protection.
