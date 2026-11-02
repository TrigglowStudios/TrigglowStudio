import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withReleaseEntry } from './release.mjs';

const entry = '## [0.6.0] - 2026-10-20\n\n- Internal improvements.\n\n';

test('a hand-written section for the version is kept as is', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-10-18\n\n- Mine\n\n## [0.5.1] - x\n';
  assert.equal(withReleaseEntry(log, '0.6.0', '2026-10-20', entry), log);
});

test('notes under [Unreleased] become the release section', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- A\n\n## [0.5.1] - x\n';
  assert.equal(withReleaseEntry(log, '0.6.0', '2026-10-20', entry), '# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-10-20\n\n### Fixed\n- A\n\n## [0.5.1] - x\n');
});

test('an empty [Unreleased] gets the generated entry below it, CRLF kept', () => {
  const log = '# C\r\n\r\n## [Unreleased]\r\n\r\n## [0.5.1] - x\r\n';
  assert.equal(withReleaseEntry(log, '0.6.0', '2026-10-20', entry), '# C\r\n\r\n## [Unreleased]\r\n\r\n## [0.6.0] - 2026-10-20\r\n\r\n- Internal improvements.\r\n\r\n## [0.5.1] - x\r\n');
});
