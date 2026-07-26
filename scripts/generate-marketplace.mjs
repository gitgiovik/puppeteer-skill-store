#!/usr/bin/env node
/**
 * generate-marketplace.mjs — derive `.claude-plugin/marketplace.json` from
 * `catalog.json` (A2.0, puppeteer-skill-store).
 *
 * WHAT THIS DOES. `catalog.json` is a verbatim mirror of the app repo's
 * `packages/skills/curated/index.json` (see README.md's "two-artifact model").
 * This script is the ONE place that turns that review-owned catalogue into the
 * Claude Code plugin-marketplace manifest format documented at
 * code.claude.com/docs/en/plugin-marketplaces:
 *   { name, owner, plugins: [{ name, source, description?, version? }] }
 * one `plugins[]` row per catalogue entry, `source` pinned to the entry's
 * upstream commit SHA (sha wins over ref, and — per the docs — survives the
 * upstream branch being deleted or force-pushed later).
 *
 * SOURCE MAPPING RULE (mechanical, no per-entry judgement calls):
 *   - `upstreamPath === '.'` (the 5 "whole repo IS the skill" rows) →
 *     `{ source: 'github', repo: 'owner/repo', sha }` — no `path`, the SKILL.md
 *     lives at the repo root for every one of these (verified against
 *     catalog.json: 5-whys, code-review-skill, kubernetes-skill, ux-designer,
 *     awwwards-3d all resolve `SKILL.md` at their archive root).
 *   - otherwise → `{ source: 'git-subdir', url: sourceUrl, path, sha }`, where
 *     `path` is derived from the entry's `upstreamPath` for the single-path
 *     rows, or — for the 3 rows that carry a real `upstreamPaths` array
 *     (ui-ux-pro-max, career-ops, watch) — the `from` of whichever mapping
 *     lands at the skill root (`to: ''`). THE LIMITATION: git-subdir can only
 *     express ONE upstream path, so every one of these 3 rows loses at least
 *     one other mapped directory (ui-ux-pro-max's `scripts/`+`data/` live
 *     under `src/ui-ux-pro-max/`, not next to its SKILL.md; career-ops's
 *     `modes/` sits at the repo root; watch's `scripts/` sits at the repo root
 *     too). That gap is recorded in the plugin's own `description` (appended,
 *     not hidden in a side file) so anyone browsing `/plugin marketplace` sees
 *     it before installing.
 *
 * `path` IS A DIRECTORY, ALWAYS (W2 review finding #5). The docs are explicit —
 * git-subdir's `path` is "the subdirectory path within the repo containing the
 * plugin" — but 13 catalogue rows name the SKILL.md FILE itself (either
 * directly in `upstreamPath` or via a multi-path `from`). {@link toPluginDir}
 * folds any such path up to its containing directory, and a path that folds all
 * the way to the repo root is re-routed to the `github` source (which is what
 * "the whole repo is the plugin" already means) rather than emitting a
 * meaningless `path: '.'`.
 *
 * EVERY PLUGIN DECLARES `skills: ['./']` (W2 review finding #4). Per the docs a
 * plugin's skills load from a `skills/` DIRECTORY under its source by default,
 * and `plugins[].skills` is the override for custom locations. Not one of our
 * sources has a `skills/` subdir — they point AT the skill directory, SKILL.md
 * at its root — so without the override all 108 plugins would install and
 * resolve to zero skills. `'./'` says "the plugin root IS the skill directory",
 * which is exactly true for both source shapes here.
 *
 * `renames` IS FORWARDED (W2 review finding #8). The docs make it a top-level,
 * APPEND-ONLY marketplace.json field mapping an old plugin name to its current
 * one; without it the first slug rename hands every existing user a
 * `plugin-not-found`. It is carried verbatim from `catalog.json` (whose curated
 * index owns the rename history), and `--check` refuses a manifest that DROPS a
 * previously-published plugin name without a `renames` entry covering it.
 *
 * VALIDATION (`--check` / CI). {@link validateManifest} checks every generated
 * row for: a resolvable `owner/repo` from `sourceUrl`, a non-empty pinned
 * `sha`, a non-empty DIRECTORY `path` for git-subdir rows, and a non-empty
 * `skills` list — and it runs on the WRITE path too, so a bad manifest is never
 * written in the first place. `--check` additionally regenerates in memory and
 * diffs against the on-disk `.claude-plugin/marketplace.json` byte-for-byte,
 * exiting non-zero when the committed manifest has drifted from `catalog.json`
 * — the CI gate `validate-entry.yml` runs this so a PR that edits
 * `catalog.json` without regenerating the manifest fails loudly instead of
 * shipping a stale marketplace.
 *
 * OFFLINE / PURE. No network, no workspace deps — reads `catalog.json`,
 * writes/compares `.claude-plugin/marketplace.json`. Safe to run in CI or by
 * hand: `node scripts/generate-marketplace.mjs [--check]`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CATALOG_PATH = join(REPO_ROOT, 'catalog.json');
const MANIFEST_PATH = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

const MARKETPLACE_NAME = 'puppeteer-skill-store';
const OWNER = { name: 'gitgiovik', url: 'https://github.com/gitgiovik' };
/** `plugins[].skills` value meaning "the plugin root IS the skill directory". */
const PLUGIN_SKILLS_ROOT = './';

/**
 * Extract `{owner, repo}` from a `https://github.com/<owner>/<repo>` URL
 * (mirrors `parseGithubOwnerRepo` in the app repo's
 * `packages/skills/src/github-subtree.ts` — duplicated here on purpose,
 * because this repo has no workspace dependency on that package; the two
 * implementations are exercised against the SAME 42-repo catalogue by
 * `validate-entry.mjs`, so a divergence would fail CI, not surface silently).
 */
function parseGithubOwnerRepo(url) {
  const trimmed = (url ?? '').trim();
  if (trimmed.length === 0) return undefined;
  const m = trimmed.match(/github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

/** True for a path segment that names a FILE — a non-empty basename followed by a
 *  dot and an extension. Deliberately NOT a bare `includes('.')`: a dotdir segment
 *  like `.claude` / `.github` / `.agents` (dot at position 0, nothing before it)
 *  must stay a directory, and those appear in real catalogue paths. */
function looksLikeFileSegment(segment) {
  return /^.+\.[A-Za-z0-9]+$/.test(segment);
}

/**
 * Fold an upstream path to the DIRECTORY that contains the plugin, which is what
 * git-subdir's `path` means per the docs (W2 review finding #5). 13 catalogue rows
 * name the SKILL.md file itself; pinning `path` at a file yields a plugin the
 * installer cannot resolve. Returns `'.'` when the containing directory is the repo
 * root — the caller re-routes that to the `github` source.
 */
export function toPluginDir(rawPath) {
  const trimmed = (rawPath ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.' || trimmed === '/') return '.';
  const segments = trimmed.split('/').filter((s) => s.length > 0 && s !== '.');
  const last = segments[segments.length - 1];
  if (last !== undefined && looksLikeFileSegment(last)) segments.pop();
  return segments.length === 0 ? '.' : segments.join('/');
}

/** Resolve one catalogue entry's marketplace `source` + any limitation note. */
function resolveSource(entry) {
  const parsed = parseGithubOwnerRepo(entry.sourceUrl);
  if (!parsed) {
    throw new Error(`'${entry.slug}': sourceUrl '${entry.sourceUrl}' is not a parseable github.com repo URL`);
  }
  const sha = (entry.upstreamCommit ?? '').trim();
  if (sha.length === 0) {
    throw new Error(`'${entry.slug}': missing upstreamCommit — refusing to emit an unpinned source`);
  }
  const githubSource = { source: 'github', repo: `${parsed.owner}/${parsed.repo}`, sha };
  const rawPath = (entry.upstreamPath ?? '').trim();
  const multiPaths = Array.isArray(entry.upstreamPaths) ? entry.upstreamPaths : [];

  // ROOT WINS, AND IT IS CHECKED FIRST. `upstreamPath: '.'` means "the whole repo IS
  // the skill" — and those rows ALSO carry an `upstreamPaths` array that simply
  // enumerates the repo's root files (`SKILL.md`, `README.md`, `.gitignore`, …), so
  // consulting `upstreamPaths` before this test would mis-derive a git-subdir path
  // from an arbitrary root file for all 5 of them.
  if (rawPath === '.' || rawPath === '/' || rawPath === '') {
    return { source: githubSource };
  }

  // Multi-path row: the SKILL.md lives at whichever mapping targets the skill root
  // (`to: ''`) — that is the ONE location git-subdir can express. Single-path rows
  // use `upstreamPath` directly. `upstreamPath` on a multi-path row is a human
  // "a + b + c" summary string, never a real path, so it is NOT consulted there.
  const primary = multiPaths.length > 0 ? (multiPaths.find((m) => (m.to ?? '') === '') ?? multiPaths[0]) : undefined;
  const others = primary ? multiPaths.filter((m) => m !== primary) : [];
  const dir = toPluginDir(primary ? primary.from : rawPath);

  if (dir === '.') {
    // The plugin IS the whole repo (either `upstreamPath: '.'` outright, or a path
    // that folded to the root because the SKILL.md sits there). A whole-repo source
    // fetches EVERY other mapped path too, so a multi-path row that lands here has
    // no exclusion left to warn about — the limitation note is dropped, not kept as
    // a stale claim about content that is in fact present.
    return { source: githubSource };
  }

  let limitation;
  if (others.length > 0) {
    limitation =
      `NOTE: this catalogue entry assembles the skill from ${multiPaths.length} upstream ` +
      `paths; this marketplace listing can only fetch one directory via git-subdir ('${dir}') ` +
      `and does NOT include: ${others.map((m) => `'${m.from}'`).join(', ')}. ` +
      `Install via the puppeteer store's own resolver for the complete payload.`;
  }
  return {
    source: { source: 'git-subdir', url: entry.sourceUrl, path: dir, sha },
    limitation,
  };
}

/** Build the full marketplace manifest object from a parsed catalog.json. */
export function buildMarketplace(catalog) {
  const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  const seen = new Set();
  const plugins = skills.map((entry) => {
    if (seen.has(entry.slug)) {
      throw new Error(`duplicate slug in catalog.json: '${entry.slug}'`);
    }
    seen.add(entry.slug);
    const { source, limitation } = resolveSource(entry);
    const description = limitation
      ? `${entry.description ?? ''}\n\n${limitation}`.trim()
      : (entry.description ?? '');
    return {
      name: entry.slug,
      ...(description.length > 0 ? { description } : {}),
      source,
      // The plugin root IS the skill directory (SKILL.md at its root) for BOTH
      // source shapes here. Without this override Claude Code looks for a
      // `skills/` subdirectory that none of our sources have, and every plugin
      // installs with zero skills. See the file header (finding #4).
      skills: [PLUGIN_SKILLS_ROOT],
    };
  });
  // APPEND-ONLY rename history, carried verbatim from catalog.json. Absent/empty ⇒
  // the field is omitted rather than emitted as `{}` (nothing has been renamed yet).
  const renames =
    catalog.renames && typeof catalog.renames === 'object' && Object.keys(catalog.renames).length > 0
      ? { ...catalog.renames }
      : undefined;
  return {
    name: MARKETPLACE_NAME,
    owner: OWNER,
    metadata: {
      description:
        'Community-curated Claude Code skills, re-pinned to their upstream commit and byte-audited ' +
        'against what was actually reviewed. See README.md for the trust model — signals here are ' +
        'unaudited heuristics, not a security guarantee.',
      catalogGeneratedAt: catalog.generatedAt ?? '',
    },
    ...(renames ? { renames } : {}),
    plugins,
  };
}

/**
 * Structural gate over a generated manifest. Runs on BOTH the write and `--check`
 * paths, so a manifest that would install nothing is never written in the first
 * place — `--check`'s byte-diff alone would happily bless a uniformly-broken file.
 */
export function validateManifest(manifest) {
  const problems = [];
  for (const p of manifest.plugins) {
    if (!p.name) problems.push('a plugin has no name');
    if (!Array.isArray(p.skills) || p.skills.length === 0) {
      problems.push(`'${p.name}': no 'skills' paths — it would install with zero skills`);
    }
    const s = p.source ?? {};
    if (!s.sha) problems.push(`'${p.name}': source is not pinned to a sha`);
    if (s.source === 'git-subdir') {
      const path = (s.path ?? '').trim();
      if (path.length === 0) problems.push(`'${p.name}': git-subdir source has an empty path`);
      else if (path === '.') problems.push(`'${p.name}': git-subdir path '.' — use the github source instead`);
      else if (looksLikeFileSegment(path.split('/').pop() ?? '')) {
        problems.push(`'${p.name}': git-subdir path '${path}' names a FILE; it must be the containing directory`);
      }
    } else if (s.source === 'github') {
      if (!s.repo) problems.push(`'${p.name}': github source has no repo`);
    } else {
      problems.push(`'${p.name}': unknown source type '${s.source}'`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`generate-marketplace: ${problems.length} invalid plugin row(s):\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * `renames` is append-only by contract: a plugin name that USED to be published and
 * is now gone must resolve through it, or existing users get `plugin-not-found`.
 * Compared against the committed manifest — the only record of what was published.
 */
export function checkRenames(previousManifest, manifest) {
  const problems = [];
  const nowNames = new Set(manifest.plugins.map((p) => p.name));
  const renames = manifest.renames ?? {};
  for (const p of previousManifest.plugins ?? []) {
    if (!nowNames.has(p.name) && renames[p.name] === undefined) {
      problems.push(`'${p.name}' was published but is gone from plugins[] with no 'renames' entry`);
    }
  }
  for (const [from, to] of Object.entries(previousManifest.renames ?? {})) {
    if (renames[from] !== to) {
      problems.push(`'renames' is append-only: the existing '${from}' → '${to}' mapping was dropped or changed`);
    }
  }
  return problems;
}

function loadCatalog() {
  if (!existsSync(CATALOG_PATH)) {
    throw new Error(`generate-marketplace: catalog.json not found at ${CATALOG_PATH}`);
  }
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

function serialize(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const catalog = loadCatalog();
  const manifest = buildMarketplace(catalog);
  // Structural gate FIRST, on both paths — see validateManifest's doc for why a
  // byte-diff alone is not enough (it blesses a uniformly-broken manifest).
  validateManifest(manifest);
  const serialized = serialize(manifest);

  if (checkOnly) {
    if (!existsSync(MANIFEST_PATH)) {
      console.error(`generate-marketplace --check: ${MANIFEST_PATH} does not exist — run without --check first.`);
      process.exit(1);
    }
    const onDiskRaw = readFileSync(MANIFEST_PATH, 'utf8');
    let previous;
    try {
      previous = JSON.parse(onDiskRaw);
    } catch {
      previous = undefined;
    }
    // The rename guard reads the COMMITTED manifest (the record of what was
    // published) and runs BEFORE the byte-diff, so a PR that drops a plugin name
    // is told WHY rather than just "stale, regenerate".
    if (previous) {
      const renameProblems = checkRenames(previous, manifest);
      if (renameProblems.length > 0) {
        console.error(
          `generate-marketplace --check: ${renameProblems.length} rename-contract violation(s):\n  - ` +
            `${renameProblems.join('\n  - ')}\n` +
            "Add the old name to catalog.json's top-level `renames` map (append-only) and regenerate.",
        );
        process.exit(1);
      }
    }
    if (onDiskRaw !== serialized) {
      console.error(
        'generate-marketplace --check: .claude-plugin/marketplace.json is STALE relative to catalog.json.\n' +
          'Run `node scripts/generate-marketplace.mjs` and commit the result.',
      );
      process.exit(1);
    }
    console.log(
      `generate-marketplace --check: OK (${manifest.plugins.length} plugins, up to date, ` +
        'every row pinned + skills-resolvable).',
    );
    return;
  }

  writeFileSync(MANIFEST_PATH, serialized, 'utf8');
  const withLimitation = manifest.plugins.filter((p) => p.description?.includes('NOTE:')).length;
  const subdir = manifest.plugins.filter((p) => p.source.source === 'git-subdir').length;
  console.log(
    `generate-marketplace: wrote ${manifest.plugins.length} plugins to ` +
      `${MANIFEST_PATH.replace(REPO_ROOT + '/', '')} (${subdir} git-subdir, ` +
      `${manifest.plugins.length - subdir} whole-repo, ` +
      `${withLimitation} with a multi-path limitation note).`,
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
