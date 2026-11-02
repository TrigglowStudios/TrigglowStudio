// Fetches the engine for Trigglow Studio: Streamlabs' prebuilt obs-studio-node (libobs + plugins, GPL-2.0) into
// vendor/obs-studio-node, plus the Trigglow Dynamic Delay core (the plugin's delay filters built for this engine,
// GPL-2.0, from the plugin's own release) inside it. Each is pinned to one version and checked against its SHA-256
// before anything is unpacked. Windows only for now (docs/design/trigglow-studio.md).
// Usage: pnpm --filter @trigglow/desktop studio:fetch
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.27.28';
const SHA256 = 'dca9725fc42a00542117bced31a94707c35ebc7fa6651ca52a396f24736adc79';
const URL_BASE = 'https://s3-us-west-2.amazonaws.com/obsstudionodes3.streamlabs.com/';

/** The Dynamic Delay core: the `-windows-x64-studio-core.zip` asset of a plugin release (its CI builds it). */
const DELAY_VERSION = '';
const DELAY_SHA256 = '';
const DELAY_URL = (v) => `https://github.com/VirosMs/obs-trigglow-dynamic-delay/releases/download/${v}/obs-trigglow-dynamic-delay-${v}-windows-x64-studio-core.zip`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const target = path.join(vendor, 'obs-studio-node');
const stamp = path.join(target, '.trigglow-osn-version');
const delayStamp = path.join(target, '.trigglow-delay-version');

if (process.platform !== 'win32') {
  console.log('studio:fetch: Trigglow Studio is Windows-only for now; nothing to do.');
  process.exit(0);
}

/** Downloads `url` into a new temp folder, checking its SHA-256 as it streams. Returns [folder, file]. */
async function download(url, sha256) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trigglow-studio-'));
  const file = path.join(tmp, path.basename(new URL(url).pathname));
  console.log(`studio:fetch: downloading ${path.basename(file)}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(file);
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  const got = hash.digest('hex');
  if (got !== sha256) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`SHA-256 mismatch for ${path.basename(file)}: expected ${sha256}, got ${got}`);
  }
  return [tmp, file];
}

const have = (file, version) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === version;

if (have(stamp, VERSION)) {
  console.log(`studio:fetch: obs-studio-node ${VERSION} already in vendor/.`);
} else {
  const [tmp, archive] = await download(URL_BASE + `osn-${VERSION}-release-win64.tar.gz`, SHA256);
  // Unpack next to the target, then swap, so a failed run never leaves half an engine behind.
  const staging = path.join(tmp, 'x');
  fs.mkdirSync(staging);
  execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
  fs.mkdirSync(vendor, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(staging, 'obs-studio-node'), target);
  fs.writeFileSync(stamp, VERSION + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`studio:fetch: obs-studio-node ${VERSION} ready in vendor/obs-studio-node.`);
}

if (!DELAY_VERSION) {
  // Not fatal, so a desktop release isn't blocked on the plugin's: Studio works, the Delay button just doesn't show.
  console.warn('studio:fetch: WARNING no Dynamic Delay core pinned yet (DELAY_VERSION): pin the first plugin release with the studio-core asset.');
} else if (have(delayStamp, DELAY_VERSION)) {
  console.log(`studio:fetch: Dynamic Delay core ${DELAY_VERSION} already in the engine.`);
} else {
  const [tmp, archive] = await download(DELAY_URL(DELAY_VERSION), DELAY_SHA256);
  // The zip mirrors the engine's layout (obs-plugins/64bit, data/obs-plugins/<name>): unpacked straight into it.
  execFileSync('tar', ['-xf', archive, '-C', target], { stdio: 'inherit' });
  fs.writeFileSync(delayStamp, DELAY_VERSION + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`studio:fetch: Dynamic Delay core ${DELAY_VERSION} ready in the engine.`);
}
