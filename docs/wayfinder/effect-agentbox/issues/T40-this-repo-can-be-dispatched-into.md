# T40 — This repo can be dispatched into

Status: Done (landed by hand in 6345f52; verified 2026-09-08 — `doctor` exits 0 with ten green rows, and criterion 4 has since been met five times over by T42, T43, T44, T45, and T39)
Type: HITL
Blocked by: None — can start immediately.

<!--
Graduated 2026-09-04 from MAP.md's "This repo cannot dispatch into itself yet, and nothing owns the
reason", surfaced 2026-08-21 and narrowed 2026-09-04 by
docs/wayfinder/effect-agentbox/research/09-p1-hae-probe-findings.md.

**HITL, and that is the point.** Every other ticket here can be AFK-dispatched; this one is what
makes AFK possible in this repo, so it cannot be. Its verification is a docker build and a `doctor`
run on the host. Once it lands, P2-P6 dispatch normally (09 Q11).
-->

## What to build

This repo can dispatch a run into itself. Today it cannot, and three values are why — all three are
hae's, sitting where this repo's own answers belong:

- `defaultConfig.image` is `"hae-agentbox"` (`src/config/config.ts`).
- `defaultConfig.base` is `"origin/master"`, against a repo whose default branch is `main`.
- `config.toml`'s `image-build-command` is `".agentbox/build-image.sh"`.

The probe narrowed this from a design gap to a missing set of values. Pointed at hae, all three are
correct and the machinery around them works: the image was found, `image-build-command` resolved
against the served repo and named hae's script in `doctor`'s failure row, and `origin/master`
produced the right diff boundary. Nothing here needs inventing — this repo needs answers.

### Where the image assets go, and where they do not

**Not `.agentbox/`.** That directory is hae's bash dispatcher carried in as the parity oracle, not
this host's dispatch directory — the extraction manifest cut it as a directory and carried only
the oracle files, and 182 line-number citations across the docs resolve into it. A second
`Dockerfile` beside hae's would make every one of those citations ambiguous. Its Dockerfile builds
on the served app's own image, and its inputs declaration names that app's dependency manifests;
this repo has neither. Leave all of it untouched.

Put this repo's image assets at the **repo root**, in `image/` — a Dockerfile, a build script, and
the inputs declaration T30 requires. Repo root rather than inside the package,
because [18](../18-where-the-package-lives-and-what-it-is-called.md) may move the package and an
image belongs to the repo whose image it is: it is the same rule that keeps `image-build-command`
and `setup-hook` out of the package's defaults (`src/config/config.ts`, `config.toml`).

`image/` holds **build-time assets only**. The setup hook is not one of them and does not go there —
see below.

The image's tag is **`bessemer-agentbox`**: this repo's name plus the suffix hae's carries, so the
two read apart in `docker images` and `grep agentbox` finds both during P7's parallel-run gate. It
names the **repo**, not the package, which is why 18 renaming `speepobox/` leaves it alone.

`image-inputs.sh` declares **the Dockerfile, and nothing else.** Nothing else is baked in: the
package's dependencies arrive at run time through the setup hook below, so `package-lock.json` is
not a thing this image was built from. Declaring it anyway would rebuild hae's original bug verbatim
— T30's own comment records that the old rule named "a rebuild it named could not clear it (that
build context holds neither lock file)", which is a permanent stale warning after every dependency
bump. The build script is left out too, as hae leaves its own out: it is the file that computes the
digest. **Note for the record**, since no file captures it: the Claude CLI is installed unpinned, so
the image's contents drift with no input change.

### What the image needs

Far less than hae's app image; start from `node:26-bookworm-slim` directly. On top of it:

- **Node ≥ 26** — `≥ 26` is what lets bessemer's TS run under plain node type stripping. The
  package has no build step and is run as source.
- The **Claude CLI** and `git` (the slim base ships without it, and the agent plus its hooks need
  the real CLI).
- A **non-root `agent` user** whose uid/gid are build args supplied by the build script, so it owns
  the bind-mounted checkout — macOS masks a mismatch and Linux does not.
- An entrypoint that keeps the container alive to `docker exec` into.

**No sudo**: nothing here needs root, so `cap-add` stays unset and
`--cap-drop ALL` stands unmodified. The probe confirmed a container starts and authenticates under
exactly that.

### The dependencies are not in the image, and this repo needs a setup hook

`node_modules/` is gitignored, so the agent's checkout is a clone that does not have it — and the
package's Verify gate, the one every ticket in this folder ends on, is `npm run verify`. Baking the
modules into the image does not reach: the checkout arrives as a bind mount at `/workspace`, which
masks anything the image put underneath it.

So this repo declares a **setup hook** — one script running `npm ci` in the package directory of the
checkout, before the agent pass. That is precisely what the hook is for (T7): a host script mounted
read-only and run inside the container, generic in the tool and declared by the repo. It runs as the
`agent` user into a directory that user already owns, so it needs no capability and the paragraph
above stands.

It lives at the **repo root, as `setup-hook.sh`** — not under `image/`. The hook is run-time, not
build-time: it is never in the image, and a script sitting in a directory called `image/` that is
deliberately absent from `image-inputs.sh` leaves a standing "why isn't this an input?" for every
future reader. One file at the root, named exactly for the config key that declares it, asks nothing.
A directory for one script would earn its keep only once there is a second.

**Consequence worth stating rather than solving here**: every run pays a cold `npm ci` over the
network. Bash gives its container a shared package-cache volume for exactly this, and this package
has no shape for one — `SandboxMount` has no mode field, the workspace being the only writable thing
by design. That is [the probe's finding 8](../research/09-p1-hae-probe-findings.md) and it belongs to
[19](../19-the-tool-serves-a-repo-it-does-not-live-in.md), not to this ticket. Slow is acceptable;
broken is not.

### What the config declares

`config.toml` gains `image = "bessemer-agentbox"` and this repo's `base`, repoints
`image-build-command` at the new build script under `image/`, and sets `setup-hook = "setup-hook.sh"`
— both paths relative to the repo root, as the keys already specify. `cap-add` stays commented out — its comment
says the first entry is earned by what a hook's root path demonstrably needs, and this hook needs
none.

Then **retire hae's values from the package's code defaults**. An `image` of `"hae-agentbox"` and a
`base` of `"origin/master"` are one repo's answers baked into a tool every other repo installs —
the exact failure `imageBuildCommand` and `setupHook` already ship empty to avoid, and their comments
carry the reasoning verbatim: a path here "that ships with the package is a pointer into hae's layout
that dangles the moment the package lives anywhere else". A repo declaring neither should be refused
by name, not silently handed hae's.

## Effect wiring

- **Tags introduced or consumed**: `AgentboxConfig` (consumed, shape unchanged). No new tag — this
  is values and host assets, not a seam.
- **Layer composition**: unchanged. `AgentboxConfigLive` keeps its
  `Layer.Layer<AgentboxConfig, ConfigError, FileSystem.FileSystem | Path.Path>` shape. Dropping
  `Config.withDefault` from the `image` and `base` descriptors turns a missing key into a
  `ConfigError`, which that layer already carries and `doctor` already reports as probe 7 — no new
  error channel, no new requirement.

## Acceptance criteria

- [ ] `doctor`, run in this repo with no `config.local.toml`, passes every probe.
- [ ] The build script builds the image this repo's config names, and `doctor`'s image row then reads
      as present and built against the current dependency files rather than as undeclared.
- [ ] The declared image inputs are files that exist in this repo, so the T30 staleness check is
      actually running rather than reporting itself unchecked.
- [ ] A dispatch of `tracer` in this repo runs to a landed commit, and `npm run verify` succeeds
      **inside the container** — which is the real proof the image is fit, where container start
      alone only proves it exists.
- [ ] `cap-add` is still unset and the container still runs under `--cap-drop ALL` with no
      capability added back.
- [ ] A config declaring no `image` and no `base` is refused by a message naming the missing key.
      Neither hae's image name nor `origin/master` survives as a code default.
- [ ] `.agentbox/` is byte-identical to what it was: no new file, no edit, no deletion.

## Verify

```
npm run verify
```

Run from the repo root. This is the gate — typecheck (with Effect diagnostics: **errors and warnings
break the build**, suggestions print), lint, and tests. `pre-commit` is not a substitute and does not
check this package.

Host-only, and the substance of this ticket — neither can run inside the agent's container, which is
why this ticket is HITL:

```
<the new build script>
node src/bin.ts doctor
```

The first must succeed; the second must exit 0 with every row green.
