# Released shim templates (T125, P6 F18)

The shim contract test (`test/shim.test.ts`) runs the current `templates/bessemer` **and every file
here** against the current package's warm path, because an adopter's committed shim keeps calling
whichever package its pin names: a package release never stops accepting a call an earlier released
shim makes (F17).

A shim template's text is kept here only for a version that appeared in a `v<N>` release:
`bessemer.v2` is the text `v1` shipped, and `bessemer.v3` is the text `v2` shipped. The `v<N>`
releases named here are the private archive repository's, cut before the public `speepobox` seed;
these files keep the release URL those releases shipped.

**Bumping a released shim template: copy its text here first, named by version** — `bessemer.v1`
for the text `TEMPLATE_VERSIONS` called v1 — unstamped, exactly as `templates/bessemer` held it.
