import fs from 'node:fs';
import path from 'node:path';

/**
 * Opening `.overlaytrigglow` packs by double-click: the installer registers the extension (electron-builder.yml
 * `fileAssociations`), so the OS launches the app with the file path (Windows/Linux: in argv, also of a second
 * launch; macOS: the `open-file` event). main.ts uploads it to the API and shows the import wizard.
 */
export const PACK_EXT = '.overlaytrigglow';
/** Above the API's own cap (Admin → Ajustes, 200 MB by default); the API gives the real answer. */
export const PACK_MAX_BYTES = 300 * 1024 * 1024;

/** The pack files among a launch's arguments (absolute, existing). */
export function packFilesFromArgv(argv: readonly string[], exists: (p: string) => boolean = (p) => fs.existsSync(p)): string[] {
  return argv.filter((a) => a.toLowerCase().endsWith(PACK_EXT) && exists(a)).map((a) => path.resolve(a));
}

/** What the app does with the API's answer to an upload: open the wizard, send to "Redeem a code", or say why not. */
export type PackStageOutcome = { kind: 'wizard'; id: string } | { kind: 'redeem' } | { kind: 'signed_out' } | { kind: 'error'; code: string };

export function packStageOutcome(status: number, body: { id?: string; error?: string }): PackStageOutcome {
  if (status === 401) return { kind: 'signed_out' };
  if (status >= 200 && status < 300 && body.id) return { kind: 'wizard', id: body.id };
  // A licensed pack (bought outside Trigglow) only installs with its code.
  if (body.error === 'license_required') return { kind: 'redeem' };
  return { kind: 'error', code: body.error ?? 'generic' };
}
