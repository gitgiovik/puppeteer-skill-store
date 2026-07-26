/**
 * tar.mjs — a tiny, dependency-free USTAR tar reader (PORTED, standalone-node
 * edition of the app repo's `packages/skills/src/pack/tar.ts::parseTar`).
 *
 * WHY A PORT, NOT AN IMPORT. This repo (puppeteer-skill-store) intentionally
 * carries no dependency on `@puppeteer/skills` or any workspace package — it
 * is consumed by GitHub Actions runners and by `/plugin marketplace add`,
 * neither of which can `pnpm install` a private monorepo. `validate-entry.mjs`
 * still needs to parse a real codeload tarball to verify `contentHash`, so the
 * parser is duplicated here VERBATIM (same algorithm, same field offsets,
 * same GNU-longname/PAX handling) rather than reinvented. If GitHub ever
 * changes what codeload emits (unlikely — USTAR has been stable for decades)
 * or a bug is found in one copy, check the other:
 *   packages/skills/src/pack/tar.ts (source of truth, has the writer half too)
 * Only the READER is ported — this repo never builds an archive, only reads
 * the ones GitHub serves.
 */

const BLOCK = 512;

function readString(block, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  return block.subarray(offset, end).toString('latin1');
}

function readOctal(block, offset, length) {
  const raw = readString(block, offset, length).trim().replace(/\0+$/, '');
  if (raw.length === 0) return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

function isZeroBlock(block) {
  for (let i = 0; i < BLOCK; i += 1) if (block[i] !== 0) return false;
  return true;
}

/**
 * Parse an uncompressed tar buffer into `{name, isDir, data}` entries. Honours
 * the USTAR `prefix` field (long paths), GNU long-name (typeflag 'L'), and
 * skips PAX/global headers ('x'/'g') and non-file special types (links,
 * devices) — only regular files ('0'/'\0') and directories ('5') surface. A
 * truncated/garbage block ends parsing gracefully (no throw). Bounded by
 * `caps.maxEntries` / `caps.maxTotalBytes` — `truncated:true` means the
 * archive hit a cap and parsing stopped early.
 */
export function parseTar(buf, caps) {
  const entries = [];
  let off = 0;
  let total = 0;
  let truncated = false;
  let pendingLongName;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (isZeroBlock(header)) break;
    off += BLOCK;

    const rawName = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const dataBlocks = Math.ceil(size / BLOCK);
    const dataLen = dataBlocks * BLOCK;

    if (typeflag === 'L') {
      const nameBytes = buf.subarray(off, off + size);
      pendingLongName = nameBytes.toString('utf8').replace(/\0+$/, '');
      off += dataLen;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      off += dataLen;
      pendingLongName = undefined;
      continue;
    }

    const name = pendingLongName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    pendingLongName = undefined;

    const isDir = typeflag === '5' || name.endsWith('/');
    const isRegular = typeflag === '0' || typeflag === '\0' || typeflag === '';

    if (isDir) {
      if (entries.length >= caps.maxEntries) {
        truncated = true;
        break;
      }
      entries.push({ name: name.replace(/\/+$/, ''), isDir: true, data: new Uint8Array(0) });
      off += dataLen;
      continue;
    }
    if (!isRegular) {
      off += dataLen;
      continue;
    }

    if (entries.length >= caps.maxEntries) {
      truncated = true;
      break;
    }
    if (total + size > caps.maxTotalBytes) {
      truncated = true;
      break;
    }
    const data = new Uint8Array(buf.subarray(off, off + size));
    total += size;
    off += dataLen;
    entries.push({ name, isDir: false, data });
  }

  return { entries, truncated };
}
