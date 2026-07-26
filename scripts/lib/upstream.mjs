/**
 * upstream.mjs — standalone-node PORT of the app repo's upstream-fetch +
 * hashing primitives, for `validate-entry.mjs`.
 *
 * WHY PORTED, NOT IMPORTED. Same reason as `tar.mjs`: this repo has no
 * workspace dependency on `@puppeteer/skills`, so it cannot `import` the
 * production TypeScript. Each function below mirrors ONE named function in
 * the app repo, verbatim in algorithm — the comment above each names its
 * source of truth. If the two ever disagree, the app repo's copy is
 * authoritative (this repo re-syncs, never the other way).
 *   - parseGithubOwnerRepo, codeloadTarballUrl, extractSubtree
 *     ← packages/skills/src/github-subtree.ts
 *   - curatedUpstreamMappings
 *     ← packages/skills/src/curated-index.ts
 *   - mapUpstreamTarEntries
 *     ← packages/skills/src/first-party-source.ts
 *   - skillFileBytes, hashSkillFileBytes
 *     ← packages/skills/src/skill-file-bytes.ts (THE canonical raw-byte hash;
 *       see that file's header for why a base64-carried binary must be
 *       decoded to raw bytes BEFORE hashing, not hashed as the base64 string)
 */
import { createHash } from 'node:crypto';

/** ← github-subtree.ts::parseGithubOwnerRepo */
export function parseGithubOwnerRepo(url) {
  const trimmed = (url ?? '').trim();
  if (trimmed.length === 0) return undefined;
  const m = trimmed.match(/github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/);
  if (!m) return undefined;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/** ← github-subtree.ts::codeloadTarballUrl */
export function codeloadTarballUrl(owner, repo, sha) {
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(sha)}`;
}

function decodeTextOrUndefined(data) {
  for (const b of data) if (b === 0) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (text.includes('�')) return undefined;
  return text;
}

function stripTopDir(name) {
  const norm = name.replace(/^\.\//, '');
  const slash = norm.indexOf('/');
  if (slash < 0) return undefined;
  const rest = norm.slice(slash + 1);
  return rest.length > 0 ? rest : undefined;
}

function basename(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}

/**
 * ← github-subtree.ts::extractSubtree. From parsed tar entries, keep only the
 * files under `<top>/<subPath>/` (or the single file AT exactly `<subPath>`),
 * re-keyed relative to `subPath`. Throws when nothing matches. A binary file
 * is carried as `{contents: base64, encoding: 'base64'}` rather than dropped.
 */
export function extractSubtree(entries, subPath, label) {
  const out = [];
  for (const ent of entries) {
    if (ent.isDir) continue;
    const rel = stripTopDir(ent.name);
    if (rel === undefined) continue;
    let subRel;
    if (rel === subPath) {
      subRel = basename(rel);
    } else if (rel.startsWith(`${subPath}/`)) {
      subRel = rel.slice(subPath.length + 1);
    } else {
      continue;
    }
    if (subRel.length === 0) continue;
    const text = decodeTextOrUndefined(ent.data);
    if (text === undefined) {
      out.push({ path: subRel, contents: Buffer.from(ent.data).toString('base64'), encoding: 'base64' });
    } else {
      out.push({ path: subRel, contents: text });
    }
  }
  if (out.length === 0) {
    throw new Error(`${label}: subPath '${subPath}' matched no files`);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** ← curated-index.ts::curatedUpstreamMappings */
export function curatedUpstreamMappings(entry) {
  const clean = (p) => (p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').trim();
  const upstreamPaths = Array.isArray(entry.upstreamPaths) ? entry.upstreamPaths : [];
  if (upstreamPaths.length > 0) {
    return upstreamPaths.map((m) => ({ from: clean(m.from), to: clean(m.to) }));
  }
  const single = clean(entry.upstreamPath ?? '');
  return single.length > 0 ? [{ from: single, to: '' }] : [];
}

/** ← first-party-source.ts::mapUpstreamTarEntries */
export function mapUpstreamTarEntries(entries, mappings, label) {
  if (mappings.length === 0) {
    throw new Error(`${label}: no upstream path mapping to resolve`);
  }
  const out = [];
  const seen = new Set();
  for (const mapping of mappings) {
    for (const file of extractSubtree(entries, mapping.from, label)) {
      const path = mapping.to.length > 0 ? `${mapping.to}/${file.path}` : file.path;
      if (seen.has(path)) {
        throw new Error(`${label}: upstream path mappings collide on '${path}' (mapping '${mapping.from}' -> '${mapping.to}')`);
      }
      seen.add(path);
      out.push({ ...file, path });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** ← skill-file-bytes.ts::skillFileBytes */
export function skillFileBytes(file) {
  return file.encoding === 'base64' ? Buffer.from(file.contents, 'base64') : Buffer.from(file.contents, 'utf8');
}

/** ← skill-file-bytes.ts::hashSkillFileBytes */
export function hashSkillFileBytes(files) {
  const h = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    h.update(f.path);
    h.update('\n');
    h.update(skillFileBytes(f));
    h.update('\n');
  }
  return h.digest('hex');
}
