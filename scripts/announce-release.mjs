#!/usr/bin/env node
/**
 * Sends a release's patch notes (its CHANGELOG.md section) to the Trigglow API, which posts them as TrigglowBot to the
 * channel an admin configured (Admin → Platform settings → "Patchnotes Discord").
 *   node scripts/announce-release.mjs <tag>      tag: desktop-vX.Y.Z
 * Env: SIBLING_SYNC_SECRET (required), ANNOUNCE_API_URL (default https://api.trigglow.com).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTS = {
  desktop: { prefix: 'desktop-v', changelog: 'CHANGELOG.md' },
};

/** Pure: "## [x.y.z] - date" section body of a changelog, or null. */
export function extractSection(md, version) {
  const sec = md.split(/^## /m).find((s) => s.startsWith(`[${version}]`));
  return sec ? sec.slice(sec.indexOf('\n') + 1).trim() : null;
}

export function parseTag(tag) {
  for (const [key, p] of Object.entries(PRODUCTS)) {
    if (tag.startsWith(p.prefix) && /^\d+\.\d+\.\d+$/.test(tag.slice(p.prefix.length))) {
      return { key, ...p, version: tag.slice(p.prefix.length) };
    }
  }
  return null;
}

async function main() {
  const tag = process.argv[2];
  const p = tag && parseTag(tag);
  if (!p) throw new Error('Usage: announce-release.mjs <desktop-vX.Y.Z>');
  const secret = process.env.SIBLING_SYNC_SECRET;
  if (!secret) return console.log('SIBLING_SYNC_SECRET not set; skipping.');

  const notes = extractSection(readFileSync(join(root, p.changelog), 'utf8'), p.version);
  if (!notes) throw new Error(`No "## [${p.version}]" section in ${p.changelog}`);

  const res = await fetch(`${process.env.ANNOUNCE_API_URL || 'https://api.trigglow.com'}/api/internal/announce-release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
    body: JSON.stringify({ product: p.key, version: p.version, notes }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  console.log(`${tag}: ${(await res.json()).status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
