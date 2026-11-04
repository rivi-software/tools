# Brand assets

The RIVI Software identity the READMEs show, each file for light grounds and `-on-dark` for dark ones:

| File | What | Shown in |
| --- | --- | --- |
| `rivi-tools.svg`, `rivi-tools-on-dark.svg` | The RIVI tools lockup: the mark beside the name | The root README's header |
| `rivi-mark.svg`, `rivi-mark-on-dark.svg` | The RIVI Software mark: an ink tile with five level bars, the middle one lit in the signal green | The sign-off at the end of every README |

The mark's geometry and colours are RIVI Software's, as [rivi.software](https://rivi.software) draws them; the mark files match the ones in [`radiotools-sdk`](https://github.com/rivi-software/radiotools-sdk/tree/main/assets). The lockup sets the name as the website's header sets its own: Bricolage Grotesque 600 ([SIL OFL 1.1](https://github.com/ateliertriay/bricolage)) at 20 px beside a 36 px mark, 10 px apart. The name is drawn as outlines, so the files load no font.

Keep these files where they are, under these names. A package README is shown on npm, away from the repository, so it loads the mark from `main` by its full address (`https://raw.githubusercontent.com/rivi-software/tools/main/assets/…`), and every version already on npm keeps that address.
