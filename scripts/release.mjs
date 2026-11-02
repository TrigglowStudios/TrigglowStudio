#!/usr/bin/env node
/**
 * Cut a desktop app release:  pnpm release <patch|minor|major|x.y.z> [--push]
 *
 * Bumps package.json, commits only that file and tags `desktop-vX.Y.Z`. Pushing the tag is what starts
 * the Release GitHub workflow (builds the installers and publishes the release; installed apps then pick it
 * up through the API's update feed). Without --push it only prints the two commands to run.
 * It also writes the CHANGELOG entry from the feat/fix commits since the last release, committed with the version bump.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const changelogPath = join(root, 'CHANGELOG.md');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Pure: next version for a bump keyword or an explicit x.y.z. */
export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [maj, min, pat] = current.split('.').map(Number);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error('Use patch, minor, major or an explicit x.y.z');
}

/** Pure: CHANGELOG section from conventional-commit subjects (feat → Added, fix → Fixed; the rest is noise). */
export function changelogEntry(version, date, subjects) {
  const pick = (type) =>
    subjects
      .map((s) => s.match(new RegExp(`^${type}(?:\\([^)]*\\))?!?: (.+)$`)))
      .filter(Boolean)
      .map((m) => `- ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}`);
  const sections = [['Added', pick('feat')], ['Fixed', pick('fix')]]
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `### ${title}\n${lines.join('\n')}`);
  return `## [${version}] - ${date}\n\n${sections.join('\n\n') || '- Internal improvements.'}\n\n`;
}

/**
 * Pure: where the release's notes go. A hand-written `## [version]` section wins (kept as is); notes written under
 * `## [Unreleased]` become the release's section; otherwise the generated entry goes below [Unreleased] (or on top).
 */
export function withReleaseEntry(log, version, date, entry) {
  const nl = log.includes('\r\n') ? '\r\n' : '\n';
  if (log.split(/\r?\n/).some((line) => line.startsWith(`## [${version}]`))) return log;
  const head = /^## \[Unreleased\][^\n]*\n/im.exec(log);
  if (head) {
    const bodyStart = head.index + head[0].length;
    const next = log.indexOf(`${nl}## [`, bodyStart);
    const body = log.slice(bodyStart, next < 0 ? log.length : next + nl.length);
    const keep = `## [Unreleased]${nl}${nl}`;
    if (body.trim()) return `${log.slice(0, head.index)}${keep}## [${version}] - ${date}${nl}${body}${log.slice(bodyStart + body.length)}`;
    return `${log.slice(0, head.index)}${keep}${entry.replace(/\n/g, nl)}${log.slice(bodyStart + body.length)}`;
  }
  const at = log.indexOf(`${nl}## [`);
  return at < 0 ? `${log}${nl}${entry.replace(/\n/g, nl)}` : `${log.slice(0, at + nl.length)}${entry.replace(/\n/g, nl)}${log.slice(at + nl.length)}`;
}

function main() {
  const [bump, flag] = process.argv.slice(2);
  if (!bump) throw new Error('Usage: pnpm release <patch|minor|major|x.y.z> [--push]');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, bump);
  const tag = `desktop-v${version}`;
  if (git('tag', '--list', tag)) {
    const pushed = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
    throw new Error(
      pushed
        ? `Tag ${tag} already exists`
        : `Tag ${tag} exists only on this PC (never pushed). Push it with:\n  git push --atomic origin HEAD ${tag}\n` +
            `or, if that is rejected, drop it and release again from an up-to-date branch:\n  git tag -d ${tag} && git reset --hard HEAD~1 && git pull`,
    );
  }
  // The build runs from GitHub: releasing from a branch that is behind would make a commit + tag that can't be pushed.
  git('fetch', '--quiet', 'origin');
  const behind = Number(git('rev-list', '--count', 'HEAD..@{upstream}') || 0);
  if (behind) throw new Error(`This branch is ${behind} commit(s) behind its upstream. Pull first (git pull), then release.`);

  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const prev = git('tag', '--list', 'desktop-v*', '--sort=-v:refname').split('\n')[0];
  const range = prev ? [`${prev}..HEAD`] : [];
  const subjects = git('log', ...range, '--format=%s').split('\n').filter(Boolean);
  const date = new Date().toISOString().slice(0, 10);
  const entry = changelogEntry(version, date, subjects);
  const log = readFileSync(changelogPath, 'utf8');
  const next = withReleaseEntry(log, version, date, entry);
  writeFileSync(changelogPath, next);
  console.log(next === log ? `CHANGELOG already has [${version}]: kept as written.` : `CHANGELOG updated for ${version}.`);

  const files = ['package.json', 'CHANGELOG.md'];
  git('add', ...files);
  // Commit ONLY the version + changelog, whatever else is staged or modified in the working tree.
  git('commit', '-m', `chore: release ${version}`, '--', ...files);
  git('tag', '-a', tag, '-m', `Trigglow Studio ${version}`);
  console.log(`Tagged ${tag}.`);

  if (flag === '--push') {
    // --atomic: the branch and the tag land together or not at all (a tag without its commit can't be built).
    git('push', '--atomic', 'origin', 'HEAD', tag);
    console.log('Pushed — the Release workflow is building it now.');
  } else {
    console.log(`\nNext (this starts the build):\n  git push --atomic origin HEAD ${tag}\n`);
  }
}

// Run only when executed directly (the pure helper above stays importable for tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
