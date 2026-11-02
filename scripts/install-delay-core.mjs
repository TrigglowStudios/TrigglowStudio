// Local builds of the Trigglow Dynamic Delay core (the plugin's delay filters without OBS's UI) into
// vendor/obs-studio-node, where Studio's engine loads it like any other libobs plugin. Releases come from
// `pnpm studio:fetch` instead (pinned, with the engine); this is for testing a core built from the plugin repo.
// Usage: pnpm studio:delay [install dir] — default: the plugin repo next to this one, built with
// -DTRIGGLOW_CORE_ONLY=ON and installed with `cmake --install build_core --prefix build_core/pkg`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.resolve(process.argv[2] ?? path.join(root, '../../../obs-trigglow-dynamic-delay/build_core/pkg/obs-trigglow-dynamic-delay'));
const osn = path.join(root, 'vendor', 'obs-studio-node');
const name = 'obs-trigglow-dynamic-delay-core';
const bin = path.join(pkg, 'bin', '64bit');
if (!fs.existsSync(path.join(bin, `${name}.dll`))) throw new Error(`studio:delay: no ${name}.dll in ${bin}`);
if (!fs.existsSync(osn)) throw new Error('studio:delay: run pnpm studio:fetch first');

// Its own FFmpeg next to it: the engine's is an older major with other DLL names, so they never clash.
for (const f of [`${name}.dll`, 'avcodec-63.dll', 'avutil-61.dll', 'swresample-7.dll']) fs.copyFileSync(path.join(bin, f), path.join(osn, 'obs-plugins', '64bit', f));
const data = path.join(osn, 'data', 'obs-plugins', name);
fs.rmSync(data, { recursive: true, force: true });
for (const dir of ['locale', 'licenses']) fs.cpSync(path.join(pkg, 'data', dir), path.join(data, dir), { recursive: true });
console.log(`studio:delay: ${name} installed in vendor/obs-studio-node.`);
