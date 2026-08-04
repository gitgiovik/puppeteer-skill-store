# puppeteer-skill-store

A community-curated catalogue of Claude Code skills, published as both a
plain JSON catalogue and a native
[Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces).
Every entry is pinned to an exact upstream commit and byte-audited against
what was actually reviewed — see [Trust model](#trust-model) for what that
does and does not mean.

## The two-artifact model

This repo produces two different things, on purpose kept apart:

| Artifact | Branch | Path on that branch | Who writes it | What it is |
|---|---|---|---|---|
| `catalog.json`, `.claude-plugin/marketplace.json` | `main` | repo root | Humans, via PR + CI | The reviewed catalogue. Every change is a diff a person read. |
| `popularity.json`, `snapshots/*.json`, `discovery.json`, `mcp-registry.json` | `data` | branch root | GitHub Actions bots, daily/weekly | Machine-generated signals. Nobody reviews these commits; they are DATA, not curation. |

`main` stays clean and auditable — a `git log` on it is a log of curation
decisions. `data` is an orphan branch (no shared history with `main`) that
exists purely so machine-written commits never show up in `main`'s history or
in a PR diff.

The bot files live at the **root of the `data` branch**, not in a `data/`
directory — the workflows check that branch out as a worktree and write into
it directly. So the raw URLs are:

```
https://raw.githubusercontent.com/gitgiovik/puppeteer-skill-store/main/catalog.json
https://raw.githubusercontent.com/gitgiovik/puppeteer-skill-store/data/popularity.json
https://raw.githubusercontent.com/gitgiovik/puppeteer-skill-store/data/snapshots/2026-07-26.json
```

In a `raw.githubusercontent.com` URL the segment after the repo is the **ref**,
so `…/puppeteer-skill-store/data/popularity.json` reads `popularity.json` from
the `data` *branch*. (Consumers: this is what `DEFAULT_STORE_DATA_URL` in the
app's `packages/skills/src/store-index-client.ts` points at.) Read
`catalog.json` from `main` and, optionally, `popularity.json` from `data` for
freshness signals — the two are independent fetches, and a store that cannot
reach the popularity document degrades to "no ranking data yet" rather than
failing.

### What `popularity.json` contains

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-26T06:20:11.104Z",
  "date": "2026-07-26",
  "entries": {                      // keyed by CATALOGUE SLUG — the consumer contract.
    "grill-me": {
      "stars": 1042,                // omitted entirely when unmeasured — never a fabricated 0.
      "pushedAt": "2026-07-21T09:12:03Z",
      "starsDelta1d": 7,            // present ONLY when a snapshot exists in that window.
      "starsDelta7d": 61,
      "deltaSince": { "starsDelta1d": "2026-07-25" },  // the date each delta was really diffed against.
      "snapshotAt": "2026-07-26T06:19:58.220Z"
    }
  },
  "repos": { "mattpocock/skills": { /* raw per-repo measurement + trending */ } },
  "tarballReachability": { "grill-me": { "reachable": true, "status": 200, "checkedAt": "…" } }
}
```

GitHub measures **repos** (65 of them); the catalogue is keyed by **slug** (302
of them), and several slugs routinely share one upstream repo — `entries` is
that fan-out, and it mirrors the app's `SkillPopularity` shape field-for-field.
A repo the GraphQL query could not resolve contributes no `entries` row at all.

### Where `catalog.json` comes from

**`catalog.json` is currently a verbatim mirror of the app repo's
`packages/skills/curated/index.json`** (the private `project-puppeteer`
monorepo's own curated-skills index). That repo remains the source of truth
for curation decisions — the review, the upstream pinning, the byte-audit —
while this repo is where the result is published for anyone to consume via
`/plugin marketplace add` or a plain HTTP fetch of `catalog.json`. Sync today
is a manual copy from that repo's `packages/skills/curated/index.json`,
gated by the same `validate-entry.yml` CI this repo runs on every PR (so a
copy that introduces a bad pin fails exactly the same way a hand-authored PR
would). A future wave may make this repo the sole source of truth and drop
the app-repo copy entirely; until then, treat `catalog.json` here as
downstream of that file, not an independent catalogue.

## What's in `catalog.json`

Each entry:

```jsonc
{
  "slug": "grill-me",
  "name": "grill-me",
  "description": "...",
  "author": "mattpocock",
  "license": "MIT",
  "sourceUrl": "https://github.com/mattpocock/skills",
  "upstreamCommit": "694fa30311e02c2639942308513555e61ee84a6f", // PINNED — never a branch/tag.
  "upstreamPath": "skills/productivity/grill-me",
  "upstreamPaths": [],       // set when the payload is assembled from >1 upstream path, or when a
                             // subtree is pinned child-by-child to leave something out (MengTo's demo/).
  "contentHash": "b9aaa352...", // sha256 over the fetched bytes at the pin — see below.
  "byteAudit": "vendored-match", // or "upstream-differs" — see Trust model.
  "reviewed": { "by": "owner", "date": "2026-07-26", "sha": "...", "verdict": "..." }
}
```

`contentHash` is a sha256 over the RAW BYTES of every file the entry resolves
to (sorted by path, `path + '\n' + rawBytes + '\n'` per file — including
files carried as base64 for binary payloads, decoded before hashing). This is
the exact scheme in the app repo's `packages/skills/src/skill-file-bytes.ts`;
`scripts/validate-entry.mjs` in this repo re-implements it standalone (see
that script's `scripts/lib/upstream.mjs` header for why it's a *port*, not an
import — this repo has no workspace dependency on the app's TypeScript
package) and fails a PR whenever a fetched entry's hash doesn't match.

## The Claude Code plugin marketplace

Add this store to Claude Code:

```
/plugin marketplace add gitgiovik/puppeteer-skill-store
```

`.claude-plugin/marketplace.json` is **generated, never hand-edited** — run
`node scripts/generate-marketplace.mjs` after any `catalog.json` change and
commit the result. CI (`validate-entry.yml`) fails a PR whose manifest has
drifted from the catalogue (`generate-marketplace.mjs --check`).

Each catalogue entry becomes one `plugins[]` row, sourced straight off its
pin:

- **Whole-repo skills** (12 entries: `upstreamPath: "."` rows, plus rows
  whose SKILL.md sits at the repo root) use
  `{ source: "github", repo: "owner/repo", sha }`.
- **Everything else** (290 entries) uses
  `{ source: "git-subdir", url, path, sha }`, where `path` is the
  **directory** containing the SKILL.md.

Every row also carries `"skills": ["./"]`. By default Claude Code loads a
plugin's skills from a `skills/` subdirectory of its source; none of our
sources have one — they point *at* the skill directory, SKILL.md at its root —
so without that override every plugin would install with zero skills. `"./"`
declares "the plugin root **is** the skill directory", which is true for both
source shapes above.

`path` is always a directory, never a file. 93 catalogue rows record the
SKILL.md file itself in `upstreamPath` (or in a multi-path `from`); the
generator folds those up to the containing directory, and a path that folds all
the way to the repo root is emitted as a `github` whole-repo source instead —
`git-subdir` with `path: "."` is not a thing.

**Known limitation — multi-path entries.** 36 plugin listings carry a
multi-path `NOTE:` in their description, and they split into two very
different cases:

- **Genuinely split payloads (9)** — `brainstorming`, `career-ops`,
  `frontend-ui-engineering`, `geo-content-optimizer`, `market-research-reports`,
  `meta-tags-optimizer`, `peer-review`, `seo-content-writer`, `ui-ux-pro-max`
  are assembled from more than one upstream **directory** that a single
  `git-subdir` source cannot express (e.g. `ui-ux-pro-max`'s SKILL.md lives at
  `.claude/skills/ui-ux-pro-max/`, but its `scripts/` and `data/` live under
  `src/ui-ux-pro-max/` — a different subtree entirely). Those listings install
  just the SKILL.md's own directory; the rest of the payload really is not
  fetched by `/plugin marketplace add`.
- **Subtractive pins (27, all MengTo)** — every `MengTo/Skills` entry
  enumerates the children of its skill directory it keeps (`SKILL.md`,
  `REFERENCES.md`/`ARTICLE.md`, `references/`, `scripts/`, `assets/`)
  specifically to leave out `demo/` (up to 9MB of runnable demos) and
  `agents/openai.yaml` (a Codex manifest this store does not ship). All those
  `from` paths sit **inside** the one directory `git-subdir` points at, so the
  marketplace install is not truncated — it is a *superset* (it also drags in
  the excluded `demo/` and `agents/`). The generator emits the note anyway: it
  is mechanical and does not compare the mappings against the derived `path`,
  so on these rows the note understates what gets installed rather than
  overstating it.

(`watch` used to be in this group; its SKILL.md is at the repo root, so it now
resolves to a whole-repo `github` source that *does* include its `scripts/`.)
The full, correct
multi-path install already works via the app repo's own curated-skill resolver
(`curatedUpstreamMappings` / `mapUpstreamTarEntries`) — this is a gap in what
the *generic marketplace format* can express, not in the catalogue's own data.

**Renaming a plugin.** `renames` is a top-level, **append-only** map in
`marketplace.json` (old name → current name); without an entry there, a slug
rename hands every existing user `plugin-not-found`. It is carried verbatim
from `catalog.json`'s own top-level `renames`, and `--check` fails a PR that
drops a previously-published plugin name without covering it — or that removes
or rewrites a mapping that was already published.

## Trust model

**Signals in this repo are unaudited heuristics, not a security or quality
guarantee.** Specifically:

- A pinned `upstreamCommit` means the *bytes* are frozen — it says nothing
  about whether those bytes are safe, well-written, or maintained.
- `byteAudit: "vendored-match"` means a human, at some point, read the bytes
  at that exact pin. `byteAudit: "upstream-differs"` means the pin resolves
  and hashes correctly, but the content is NOT what was last read by a human
  (a superset the review pruned, a local patch that's no longer shipped, or a
  whole-repo pin) — Claude Code's own install tier floors these to
  "one-click", requiring a human confirmation before install.
- Popularity numbers in `popularity.json` (the `data` branch) (stars, forks, trending) are
  GitHub API mirrors, refreshed daily, with **no manual review** — a
  well-marketed but poorly-maintained skill can have high stars.
- `discovery.json` (the `data` branch) candidates are **never auto-added** to `catalog.json`
  — every new entry goes through the same PR + CI path as any other change.
- License information (`license` field, and `validate-entry.yml`'s
  "top-level LICENSE file present" check) reflects what the upstream repo
  states or ships; it is not legal advice, and a repo without a detected
  LICENSE file is flagged, not silently accepted.

Use this catalogue as a starting point for your own review, not a substitute
for it.

## How to add an entry

1. Open a PR against `main` that adds a row to `catalog.json` (and, if the
   entry is genuinely new rather than a re-pin, an entry to
   `.claude-plugin/marketplace.json` via
   `node scripts/generate-marketplace.mjs`).
2. CI (`validate-entry.yml`) runs `scripts/validate-entry.mjs` against every
   slug your PR added or changed: it fetches the pinned tarball, resolves
   `upstreamPath`/`upstreamPaths`, re-hashes the raw bytes, and requires the
   result to equal your `contentHash`. It also checks the upstream repo for a
   top-level LICENSE file, and enforces the byte-review invariant
   `reviewed.sha === upstreamCommit || byteAudit === "upstream-differs"` —
   `vendored-match` may only stand at the sha a human actually read, because it
   is what grants unattended installs. All three must pass.
3. `generate-marketplace.mjs --check` must show the marketplace manifest as
   up to date with your `catalog.json` change.
4. A human reviews the PR like any other change to reviewed content.

`discovery.json` on the `data` branch (updated weekly) is a good place to look for
candidates — it lists repos matching a small set of GitHub topic searches and
new `SKILL.md` directories appearing in already-known collection repos, with
no auto-add.

## Weekly pin-bump bot

A `winget`/Scoop-style version-bump bot, not a discovery tool: every Wednesday,
`weekly-pin-bump.yml` runs `scripts/propose-pin-bumps.mjs` against every
already-curated entry and proposes moving stale pins forward — it never adds a
new entry, only re-pins existing ones.

For each **distinct repo** in `catalog.json` it resolves the current
default-branch HEAD once, then for every entry pinned to that repo whose
`upstreamCommit` is behind HEAD it diffs `oldPin...HEAD` and checks whether any
changed file falls under **that entry's own resolved subtree** — a repo-wide
commit that never touches a given skill's directory bumps nothing for that
skill. (GitHub's compare API caps the file list at ~300 with no explicit
truncation flag; hitting that cap fails OPEN — the entry is proposed anyway
rather than silently skipped, and the PR flags it for closer human look. The
compare result is cached per repo+pin, so that fail-open is a per-*repo*
verdict every entry sharing the pin inherits; the PR body names the affected
rows grouped by repo rather than flagging "at least one".)

Entries that clear the subtree check are bumped **up to `--max`** (default 20 —
a bound on one PR's size, not a priority order) in one cumulative PR per run;
anything past the bound is logged as deferred and picked up next week, never
partially applied. Each bumped row gets exactly four field changes —
`upstreamCommit`, `contentHash` (recomputed from the bytes fetched at the new
pin with the same canonical hash `validate-entry.mjs` re-checks),
`catalogRevision += 1`, and **`byteAudit` demoted to `upstream-differs`**.
`reviewed`, `author`, `license`, and `description` are left untouched, and the
PR body says explicitly that `reviewed.sha` on a bumped row still refers to the
*old* pin — a bot cannot re-review new bytes.

**Why the demotion is mandatory.** `byteAudit: "vendored-match"` is the only
thing that earns install tier `auto` (unattended install, no confirmation), and
the audit summary the user reads for such an entry says the bytes are
byte-identical to what was reviewed. A bump moves the pin to an unreviewed HEAD
*and* recomputes `contentHash` from exactly those unread bytes — so keeping
`vendored-match` would carry a byte-review verdict onto bytes nobody read, and
CI could not catch it (`contentHash` matches by construction). Bumped skills
therefore drop to `one-click` until a human re-reads the bytes and restores
`vendored-match` together with `reviewed`. `validate-entry.mjs` enforces the
invariant `reviewed.sha === upstreamCommit || byteAudit === "upstream-differs"`
on every checked entry, so the same shortcut is refused from a hand-edit too.

The existing `validate-entry.yml` gate re-verifies every bumped row exactly like
a human-authored PR; **nothing here is ever auto-merged.**

```
node scripts/propose-pin-bumps.mjs --dry-run          # print the report, touch nothing
node scripts/propose-pin-bumps.mjs --dry-run --max 5  # same, capped for a quick check
node scripts/propose-pin-bumps.mjs --max 20           # real run: writes catalog.json, branches, opens the PR
```

`--dry-run` still makes the real GitHub API calls (HEAD resolution + compare)
so its report reflects the actual catalogue state — it only skips the
catalog.json write, the branch, and `gh pr create`. Also runnable on demand via
the workflow's `workflow_dispatch` inputs (`dry_run`, `max`).

## Bundle-refs audit (pre-install "references outside the pinned subtree")

`scripts/audit-bundle-refs.mjs` hunts the bug class that shipped as
`digitalsamba-video-toolkit`: an entry whose `upstreamPath`/`upstreamPaths`
pinned a narrow subtree while its SKILL.md's own text pointed at sibling
files that live OUTSIDE that subtree — so the install produces a truncated
payload that breaks on first real invocation. The app repo's
`packages/skill-runtime/src/skill-vendoring-lint.ts` catches this same shape
of bug, but only on skills a user has ALREADY installed — too late, and not
this repo's problem to fix at that point. This script runs the equivalent
check **pre-install**, catalog-wide, against the real upstream tarball at
each entry's pin, so a broken mapping is caught here, before anyone installs
it.

For every `catalog.json` entry it: fetches the upstream tarball (codeload,
cached on disk per `owner/repo@sha` — many entries share a repo+pin, so this
turns an O(211) fetch into O(unique archives), 72 at the time this was
written); resolves `curatedUpstreamMappings` + the same `mapUpstreamTarEntries`
algorithm the real install uses to get the exact payload an install would
produce; reads every `SKILL.md` in that payload (a multi-skill/plugin bundle
like digitalsamba's has no single root one); and extracts every path-like
reference the body makes, using the runtime lint's own bundle-prefix rules
(`scripts|assets|reference|references|resources`, `.claude/skills/<own>/…`,
`skill_run_script`/`skill_read` helper calls) **plus one heuristic this audit
adds** for refs an author writes WITHOUT a recognised bundle prefix at all —
exactly digitalsamba's `python3 tools/generate_voice.py` shape (an
interpreter command, or a backtick-quoted inline-code path, naming a
relative path with a known code/doc/asset extension).

Every ref not already present in the resolved payload is classified, ground
truth first:

- **FIXABLE** — the file exists somewhere else in the fetched repo at the
  pinned sha; a mapping (or root-expansion) would include it. The report
  names the exact repo path found and proposes the mapping.
- **UPSTREAM-MISSING** — the file does not exist ANYWHERE in the repo at the
  pin (a placeholder the author expects the end user to supply later, e.g.
  `assets/voices/reference.m4a`).
- **FALSE-POSITIVE** — the "ref" is very likely prose, a template variable, an
  absolute/generated-output path, or — the two filters that run BEFORE the
  ground-truth search, because they encode the AUTHOR explicitly saying "this
  is someone else's file" — a named reference to a **different** skill
  (`the \`mutation-testing\` skill's …`) or to `<x>/SKILL.md` (structurally
  always another skill's manifest) — plus one filter that runs AFTER it,
  because it needs the hit to decide: a `../<x>/SKILL.md` whose sibling is
  **already published as its own catalogue entry** (same repo, pinned exactly
  at that directory, slug equal to that directory's name). Installs land at
  `<root>/.puppeteer/skills/<slug>/`, so the two sit side by side and the
  relative path resolves literally — and no mapping on the referencing entry
  could ever satisfy it, since a mapping only places files *inside* that
  skill's own directory. Nothing is ever silently dropped: every
  candidate that doesn't survive lands in one of these three buckets, with
  the rule (`r1`-`r4`) and reason that put it there, so a reviewer can filter
  by confidence instead of trusting a flat count.

`..` segments are POSIX-normalised against the referencing SKILL.md's own
directory before any of this — both when checking the payload and when
searching the repo. Skipping that step is how the first version of this script
filed `gws-sheets`'s `../gws-shared/SKILL.md` as UPSTREAM-MISSING ("exists
nowhere in the repo") while the file sat one directory over: a false negative
on FIXABLE, the one direction this tool must never fail in.

The heuristic's honesty is measured, not asserted: the report's
`heuristics.r1r2r3FalsePositiveCount` / `r4FalsePositiveCount` fields count
how many of each rule's **findings** ended up FALSE-POSITIVE on the actual
catalogue, so the false-positive rate is a number from a real run, not a
claim. Mind that denominator — it is `*FindingCount`, and the fields are named
for it: a candidate that resolved inside the payload never becomes a finding
and is never counted, so the published ratio is "false positives per REPORTED
finding of that rule", not the rule's precision over everything it matched in
the SKILL.md text (a much larger, much more flattering denominator).

Recall is bounded too, and stated rather than implied: a ref written **only**
as a markdown link target (`[label](some/path.md)`) with no bundle prefix is
extracted by no rule — widening the heuristic to link targets would drag in
every documentation URL authors write in link form. A clean run therefore means
"no findings by these rules", never "no refs outside the subtree".

**Read every FIXABLE finding before repinning anything** — this audit
surfaces candidates well; it does not replace a human deciding whether the
right fix is a mapping, a root-expansion, a new sibling entry, or nothing at
all (a checklist-style skill vendored from inside the very product repo it
documents, e.g. citing `src/redteam/plugins/base.ts` as a contributor's
checklist item, legitimately names real files in that repo without needing any
of them bundled — that entry, `promptfoo-redteam-plugin-development`, plus
`xiaolai-claude-code`'s `.claude-plugin/plugin.json`, are the catalogue's
standing, deliberately-unfixed FIXABLE findings).

```
node scripts/audit-bundle-refs.mjs                        # full catalogue, network fetch
node scripts/audit-bundle-refs.mjs --slugs a,b,c          # just these slugs
node scripts/audit-bundle-refs.mjs --json-out report.json # full JSON report
AUDIT_TARBALL_CACHE=<dir> node scripts/audit-bundle-refs.mjs   # override the disk cache (default .audit-cache/, gitignored)
```

Exit code is 1 iff at least one FIXABLE finding exists. `audit-bundle-refs.yml`
runs it weekly (Thursday 05:45 UTC, offset from the other three scheduled
jobs) and is **non-blocking by design** — a FIXABLE finding is a real
catalogue defect worth attention, not something a PR should be failed over —
so the job goes green and posts a summary table + the full JSON as a
workflow artifact instead of failing. That is not automatic: FIXABLE > 0 is
this catalogue's steady state (the two standing findings above), GitHub runs
each `run:` block as `bash -e`, and `set -uo pipefail` does **not** clear that
`-e` — so the step catches the exit code with `|| audit_exit=$?` (which both
suppresses the abort and preserves the REAL code; a bare `|| true` would leave
`$?` at 0 and publish a fabricated success) and republishes it as the first
line of the job summary, where the signal is actually readable.

## Repo layout

```
catalog.json                          # the reviewed catalogue (main branch)
.claude-plugin/marketplace.json       # generated from catalog.json — see generate-marketplace.mjs
scripts/
  generate-marketplace.mjs            # catalog.json -> marketplace.json
  collect-snapshot.mjs                # daily: GraphQL stats + tarball reachability + MCP registry sync
  discover.mjs                        # weekly: Search API + known-repo enumeration -> candidates
  validate-entry.mjs                  # PR CI: re-fetch + re-hash + license check for changed entries
  propose-pin-bumps.mjs               # weekly: subtree-scoped pin bumps -> one cumulative PR (never auto-merged)
  audit-bundle-refs.mjs               # weekly (non-blocking): catalog-wide "refs outside the pinned subtree" audit
  lib/
    tar.mjs                           # standalone USTAR reader (ported from packages/skills/src/pack/tar.ts)
    upstream.mjs                      # standalone upstream-fetch + hash primitives (ported, see file header)
.github/workflows/
  validate-entry.yml                  # on every PR touching catalog.json / marketplace.json / scripts/
  daily-snapshot.yml                  # cron: writes to the `data` branch
  weekly-discovery.yml                # cron: writes to the `data` branch
  weekly-pin-bump.yml                 # cron: opens a PR against main (human-reviewed, gated by validate-entry.yml)
  audit-bundle-refs.yml               # cron: non-blocking, posts a summary + JSON artifact (never opens a PR)
data/                                 # NOT in this branch — lives on the orphan `data` branch (see above)
```

## Rate-limit posture

- **Daily snapshot**: one aliased GitHub GraphQL query for the ~65 distinct
  upstream repos (a couple of GraphQL points out of 5000/h), plus one
  sequential, paced HEAD request per pinned tarball, plus one MCP registry
  delta sync (`updated_since` cursor, unauthenticated).
- **Weekly discovery**: a small, fixed list of GitHub Search queries, paced
  to stay well under Search's separate 30-req/min ceiling — kept in its own
  workflow specifically so it can never interfere with the daily job's
  budget.
- **PR validation**: bounded to the entries a PR actually changes, not the
  whole catalogue.
- **Weekly pin-bump**: one HEAD resolution + one commits call per distinct
  repo (~63), plus one compare call per stale-pinned entry (cached per
  repo+base+head pin, so entries sharing a pin cost one call, not N) — same
  core REST budget as the daily snapshot, on a different day. Only entries
  that clear the subtree check (bounded by `--max`) go on to a tarball
  fetch + re-hash, the actually expensive step.

`collect-snapshot.mjs` and `discover.mjs` accept `--dry-run` to print the
exact plan (which repos, which queries) without spending any network budget.
`validate-entry.mjs` accepts `--slugs a,b,c` to check an explicit list on
demand, or `--all` for a full-catalogue audit (expensive — not run on every PR).
`propose-pin-bumps.mjs --dry-run` spends the real HEAD-resolution + compare
budget (so its report is accurate) but skips the tarball-fetch/re-hash step
and never writes, branches, or opens a PR.

## Changelog

- **2026-08-04** — design + engineering import (91 entries): 211 → **302**.
  **71 from `MengTo/Skills`** (MIT, pinned at `46abf786`) — 8 style presets,
  25 implementation techniques, 8 doctrine playbooks, 5 page archetypes, 5
  Codex loops, 2 media/UI helpers and 18 Three.js game-development skills.
  None of them pins the whole skill directory: each entry enumerates the
  children it keeps via `upstreamPaths`, leaving out `demo/` (runnable demos,
  up to 9MB each) and `agents/openai.yaml` (a Codex manifest this store does
  not ship). Every retained bundle file that a `SKILL.md` actually reads is
  pinned — `references/`, `scripts/`, `assets/` (13 PNGs for
  `editorial-portfolio-chapters`) — the defect class the bundle-refs audit
  exists to catch. Two deliberate exceptions are recorded in the entries'
  own `reviewed.verdict`: five scroll skills whose `SKILL.md` points at
  `demo/` as an *optional* working reference, and `build-game-map-editor`,
  whose entire `references/` was one Vesperfall-specific implementation map
  that the owner excluded — so that entry pins no `references/` at all and
  its `SKILL.md` link dangles, stated rather than hidden.
  **20 from `mattpocock/skills`** (MIT, pinned at `2ab95809`, a newer pin than
  the 9 rows already in the catalogue) — pinned whole-directory, `agents/`
  sidecar included, since payloads like `wizard/template.sh`,
  `git-guardrails-claude-code/scripts/block-dangerous-git.sh` and
  `setup-matt-pocock-skills`'s tracker docs are load-bearing. 14 of them set
  `disable-model-invocation: true` upstream, which makes their upstream
  description deliberately human-facing; the catalogue descriptions for those
  are written here, model-facing and trigger-rich, or the suggestion matcher
  would never reach them. Six live under the upstream's `in-progress/` and say
  so in their description.
- **2026-07-27** — `gws-shared` imported (`googleworkspace/cli`, Apache-2.0,
  pinned at `skills/gws-shared`, same pin as its two siblings): 210 → **211**
  entries. Not a discretionary import: `gws-sheets` and `gws-drive` both open
  with "**PREREQUISITE:** Read `../gws-shared/SKILL.md`" and both shipped a
  ONE-file payload, so each installed a skill that ordered the agent to read a
  file nobody had. `../` walks out of a skill's own installed directory, so no
  mapping on those entries could ever satisfy it — only publishing the sibling
  can, because the install layout (`<root>/.puppeteer/skills/<slug>/`) puts the
  two side by side and makes the relative path resolve literally. Found by
  `audit-bundle-refs.mjs` only after its `..`-normalisation fix landed (before
  that it called the ref UPSTREAM-MISSING — "exists nowhere in the repo" — about
  a file one directory over).
- **2026-07-27** — `scroll-world` imported (`oso95/scroll-world`, MIT, pinned at
  `skills/scroll-world`): 209 → **210** entries. Catalogue-only — deliberately
  not a member of any curated pack.
- **2026-07-26** — verified imports (`sentry-security-review`,
  `stripe-best-practices`, `expo-router`, `gemini-api-dev`, `gemini-live-api-dev`
  + 3): 201 → 209 entries; `marketplace.json` regenerated to match. This line was
  missing from the changelog until 2026-07-27 — it is backfilled here, which is
  also why the count above read a stale `201` for a day.
- **2026-07-26** — catalogue extended (owner selection + aggregators): 108 → 201
  entries. The owner-approved batch was 94; at close, 6 `nlb-*` rows were found
  pinned to `<skill-dir>/SKILL.md` instead of `<skill-dir>`, which shipped a
  one-file payload of a skill that routes into `references/`, `scripts/` and
  `data/`. Five were repointed at their directory and re-hashed (18, 27, 35, 6
  and 98 files respectively); `nlb-banner-design` was dropped because every step
  of it invokes sibling skills that exist neither upstream nor here.
  `nlb-ui-styling` was relicensed to `Apache-2.0 (skill) + OFL-1.1 (bundled
  fonts)` to match the `LICENSE.txt` and 54 fonts the directory actually ships.
