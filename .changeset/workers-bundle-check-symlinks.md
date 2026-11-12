---
"@rivi-software/workers-bundle-check": patch
---

The check now follows symbolic links as Wrangler does. Before, it passed over every link in the assets directory, though Wrangler serves a link to a file as that file, so a linked `.map` file or `.env` was served unreported. A link to a file in the assets now counts as the file, a link to a directory serves the files in it, and a report names each by its path in the assets directory. In `serverDir`, a link to a file is read too, and a link to a directory is not followed, on every Node version.
