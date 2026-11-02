/**
 * Where OBS Studio and Streamlabs Desktop keep their scene collections on this PC, read only (studio-import.ts turns
 * them into Studio's). Windows paths; nothing here ever writes to their folders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseIni } from './studio-import';

export interface FoundCollection {
  /** `obs:<file name>` or `slobs:<collection id>`. */
  id: string;
  app: 'obs' | 'slobs';
  name: string;
  /** Last change, ms. */
  modified: number;
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const readIni = (file: string) => {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

/**
 * OBS's folders: `%APPDATA%\obs-studio`, unless global.ini moved the scene collections or profiles somewhere else
 * (OBS 31: [Locations] SceneCollections / Profiles, each a folder that holds `obs-studio\basic\...`).
 */
function obsDirs(appData: string) {
  const root = path.join(appData, 'obs-studio');
  const loc = readIni(path.join(root, 'global.ini')).Locations ?? {};
  const under = (base: string | undefined, sub: string) => path.join(base ? path.join(base.replace(/\\\\/g, '\\'), 'obs-studio') : root, 'basic', sub);
  return { root, scenes: under(loc.SceneCollections, 'scenes'), profiles: under(loc.Profiles, 'profiles') };
}

const SLOBS_DIR = (appData: string) => path.join(appData, 'slobs-client', 'SceneCollections');

/** Every collection OBS and Streamlabs Desktop have on this PC, newest first. */
export function findCollections(appData = process.env.APPDATA ?? ''): FoundCollection[] {
  const out: FoundCollection[] = [];
  if (!appData) return out;
  const { scenes } = obsDirs(appData);
  try {
    for (const f of fs.readdirSync(scenes)) {
      if (!f.toLowerCase().endsWith('.json')) continue; // never the .bak copies
      const file = path.join(scenes, f);
      let name = f.replace(/\.json$/i, '').replace(/_/g, ' ');
      try {
        const raw = readJson(file) as { name?: unknown };
        if (typeof raw.name === 'string' && raw.name.trim()) name = raw.name.trim();
      } catch {
        continue; // unreadable: not offered
      }
      out.push({ id: `obs:${f}`, app: 'obs', name, modified: fs.statSync(file).mtimeMs });
    }
  } catch {
    /* no OBS here */
  }
  const sl = SLOBS_DIR(appData);
  try {
    const manifest = readJson(path.join(sl, 'manifest.json')) as { collections?: { id?: unknown; name?: unknown; deleted?: unknown; modified?: unknown }[] };
    for (const c of manifest.collections ?? []) {
      if (typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || c.deleted === true) continue;
      const file = path.join(sl, `${c.id}.json`);
      if (!fs.existsSync(file)) continue;
      out.push({ id: `slobs:${c.id}`, app: 'slobs', name: typeof c.name === 'string' && c.name ? c.name : c.id, modified: typeof c.modified === 'number' ? c.modified : fs.statSync(file).mtimeMs });
    }
  } catch {
    /* no Streamlabs here */
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** The collection behind an id from findCollections (re-checked: only those folders, only plain file names). */
export function readCollection(id: string, appData = process.env.APPDATA ?? ''): { app: 'obs' | 'slobs'; raw: unknown } | null {
  const m = /^(obs|slobs):([^\\/]{1,200})$/.exec(id);
  if (!m || !appData || m[2].includes('..')) return null;
  const file = m[1] === 'obs' ? path.join(obsDirs(appData).scenes, m[2]) : path.join(SLOBS_DIR(appData), `${m[2]}.json`);
  if (m[1] === 'obs' && !m[2].toLowerCase().endsWith('.json')) return null;
  try {
    return { app: m[1] as 'obs' | 'slobs', raw: readJson(file) };
  } catch {
    return null;
  }
}

/** OBS's active profile: its basic.ini and service.json (stream destination), when there is one. */
/** OBS's custom browser docks setting (raw JSON text), from user.ini (OBS 31) or global.ini. */
export function obsDocksSetting(appData = process.env.APPDATA ?? ''): string | undefined {
  if (!appData) return undefined;
  const { root } = obsDirs(appData);
  return readIni(path.join(root, 'user.ini')).BasicWindow?.ExtraBrowserDocks ?? readIni(path.join(root, 'global.ini')).BasicWindow?.ExtraBrowserDocks;
}

export function obsProfile(appData = process.env.APPDATA ?? ''): { ini: Record<string, Record<string, string>>; service: unknown } | null {
  if (!appData) return null;
  const { root, profiles } = obsDirs(appData);
  // OBS 31 keeps the current profile in user.ini; older versions in global.ini.
  const basic = readIni(path.join(root, 'user.ini')).Basic ?? readIni(path.join(root, 'global.ini')).Basic ?? {};
  const dir = basic.ProfileDir || basic.Profile;
  if (!dir || /[\\/]|\.\./.test(dir)) return null;
  const folder = path.join(profiles, dir);
  if (!fs.existsSync(path.join(folder, 'basic.ini'))) return null;
  let service: unknown = null;
  try {
    service = readJson(path.join(folder, 'service.json'));
  } catch {
    /* no destination saved */
  }
  return { ini: readIni(path.join(folder, 'basic.ini')), service };
}
