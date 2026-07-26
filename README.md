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

GitHub measures **repos** (42 of them); the catalogue is keyed by **slug** (108
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
  "upstreamPaths": [],       // non-empty ONLY for the 3 entries assembled from >1 upstream dir.
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

- **Whole-repo skills** (9 entries: the 5 whose `upstreamPath` is `.`, plus
  the 4 whose SKILL.md sits at the repo root) use
  `{ source: "github", repo: "owner/repo", sha }`.
- **Everything else** (99 entries) uses
  `{ source: "git-subdir", url, path, sha }`, where `path` is the
  **directory** containing the SKILL.md.

Every row also carries `"skills": ["./"]`. By default Claude Code loads a
plugin's skills from a `skills/` subdirectory of its source; none of our
sources have one — they point *at* the skill directory, SKILL.md at its root —
so without that override every plugin would install with zero skills. `"./"`
declares "the plugin root **is** the skill directory", which is true for both
source shapes above.

`path` is always a directory, never a file. 13 catalogue rows record the
SKILL.md file itself in `upstreamPath` (or in a multi-path `from`); the
generator folds those up to the containing directory, and a path that folds all
the way to the repo root is emitted as a `github` whole-repo source instead —
`git-subdir` with `path: "."` is not a thing.

**Known limitation — multi-path entries.** 2 catalogue entries
(`ui-ux-pro-max`, `career-ops`) are assembled from more than one upstream
directory that a single `git-subdir` source cannot express (e.g.
`ui-ux-pro-max`'s SKILL.md lives at `.claude/skills/ui-ux-pro-max/`, but its
`scripts/` and `data/` live under `src/ui-ux-pro-max/` — a different subtree
entirely). Those 2 plugin listings install just the SKILL.md's own directory;
the rest of the payload is not fetched by `/plugin marketplace add`, and each
affected plugin's `description` says so explicitly. (`watch` used to be in this
group; its SKILL.md is at the repo root, so it now resolves to a whole-repo
`github` source that *does* include its `scripts/`.) The full, correct
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
   top-level LICENSE file. Both must pass.
3. `generate-marketplace.mjs --check` must show the marketplace manifest as
   up to date with your `catalog.json` change.
4. A human reviews the PR like any other change to reviewed content.

`discovery.json` on the `data` branch (updated weekly) is a good place to look for
candidates — it lists repos matching a small set of GitHub topic searches and
new `SKILL.md` directories appearing in already-known collection repos, with
no auto-add.

## Repo layout

```
catalog.json                          # the reviewed catalogue (main branch)
.claude-plugin/marketplace.json       # generated from catalog.json — see generate-marketplace.mjs
scripts/
  generate-marketplace.mjs            # catalog.json -> marketplace.json
  collect-snapshot.mjs                # daily: GraphQL stats + tarball reachability + MCP registry sync
  discover.mjs                        # weekly: Search API + known-repo enumeration -> candidates
  validate-entry.mjs                  # PR CI: re-fetch + re-hash + license check for changed entries
  lib/
    tar.mjs                           # standalone USTAR reader (ported from packages/skills/src/pack/tar.ts)
    upstream.mjs                      # standalone upstream-fetch + hash primitives (ported, see file header)
.github/workflows/
  validate-entry.yml                  # on every PR touching catalog.json / marketplace.json / scripts/
  daily-snapshot.yml                  # cron: writes to the `data` branch
  weekly-discovery.yml                # cron: writes to the `data` branch
data/                                 # NOT in this branch — lives on the orphan `data` branch (see above)
```

## Rate-limit posture

- **Daily snapshot**: one aliased GitHub GraphQL query for the ~42 distinct
  upstream repos (a couple of GraphQL points out of 5000/h), plus one
  sequential, paced HEAD request per pinned tarball, plus one MCP registry
  delta sync (`updated_since` cursor, unauthenticated).
- **Weekly discovery**: a small, fixed list of GitHub Search queries, paced
  to stay well under Search's separate 30-req/min ceiling — kept in its own
  workflow specifically so it can never interfere with the daily job's
  budget.
- **PR validation**: bounded to the entries a PR actually changes, not the
  whole catalogue.

`collect-snapshot.mjs` and `discover.mjs` accept `--dry-run` to print the
exact plan (which repos, which queries) without spending any network budget.
`validate-entry.mjs` accepts `--slugs a,b,c` to check an explicit list on
demand, or `--all` for a full-catalogue audit (expensive — not run on every PR).
