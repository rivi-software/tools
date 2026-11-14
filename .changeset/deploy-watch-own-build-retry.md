---
"@rivi-software/deploy-watch": patch
---

A tab whose request for its own build's copy (`assets/deploy-watch-<id>.json`) fails now asks for it again at its next check, up to three times in all. Once it has the copy, a live build with the same browser code stops being new: the notice goes away and the next move to another page stays a client-side move. Only an answer that the copy is not there (a 404 or 410, or a body that is not a build file) is final. Before, any failed request was final, including a timeout, a network error or a 5xx. After a server-only deploy, a tab that missed `build.json` and then lost that one request took the deploy as new for the rest of its life: it showed the new-version notice, showed every module's notice, and loaded the whole page at its next move.
