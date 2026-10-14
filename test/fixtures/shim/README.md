# Released shim templates (T125, P6 F18)

The shim contract test (`test/shim.test.ts`) runs the current `templates/speepobox` **and every file
here** against the current package's warm path, because an adopter's committed shim keeps calling
whichever package its pin names: a package release never stops accepting a call an earlier released
shim makes (F17).

A shim template's text is kept here only for a version that appeared in a `v<N>` release.

**Bumping a released shim template: copy its text here first, named by version** — `speepobox.v5`
for the text `TEMPLATE_VERSIONS` calls v5 — unstamped, exactly as `templates/speepobox` held it.

T144 renamed the tool as one break, so the shims named `bessemer` were retired: `bessemer.v2` and
`bessemer.v3` left this directory. They read `.bessemer/config.toml` and ran only against releases
named `bessemer`, and those releases are unchanged.
