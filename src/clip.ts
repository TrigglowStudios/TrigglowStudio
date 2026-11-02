import { app, Notification, session } from 'electron';
import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compressReplay } from './compress';
import { nt, type MsgKey } from './messages';
import { buildMultipart } from './multipart';
import type { EngineLink } from './obs';
import type { ClipVisibility } from './config';

/** What the streamer chose in the Clips card (config prefs) for every clip made on this PC. */
export interface ClipPrefs {
  maxBytes: number;
  /** null = keep OBS's output size. */
  maxHeight: number | null;
  visibility: ClipVisibility;
  /** {game} is filled by the server, {date} here. */
  title: string;
  announceText: string;
}

const MIME: Record<string, string> = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  webm: 'video/webm',
};

type ClipFailure =
  | 'obs_not_connected'
  | 'replay_started'
  | 'replay_unavailable'
  | 'save_failed'
  | 'too_large'
  | 'unsupported'
  | 'too_long'
  | 'clips_unavailable'
  | 'clips_disabled'
  | 'rate_limited'
  | 'not_signed_in'
  | 'upload_failed'
  | 'busy'
  /** Not a failure: saved for after the stream (clipUploadMode 'after_stream'). */
  | 'deferred';

type ClipOutcome = { ok: true; id: string; title: string } | { ok: false; reason: ClipFailure };

let busy = false;
export const isClipBusy = () => busy;
/** The queue retry has its own lock, so a clip hotkey still works while parked clips upload after the stream. */
let retrying = false;
/** Queue entries an upload is running for right now — the other path must not send them twice. */
const uploading = new Set<string>();

/** What the Clips page shows while a clip is being made: saving in OBS → uploading → done / failed (then idle again). */
interface ClipProgress {
  /** 'deferred' = saved on this PC, uploads once the stream ends / OBS closes (clipUploadMode 'after_stream'). */
  phase: 'idle' | 'saving' | 'compressing' | 'uploading' | 'deferred' | 'done' | 'failed';
  reason?: ClipFailure;
  detail?: string;
  title?: string;
  /** Changes on every update, so a page can tell "a new clip just finished" from "still the same one". */
  seq: number;
}
let progress: ClipProgress = { phase: 'idle', seq: 0 };
let progressListener: (() => void) | null = null;
let idleTimer: NodeJS.Timeout | null = null;
export const getClipProgress = () => progress;
export const onClipProgress = (fn: () => void) => {
  progressListener = fn;
};
function setProgress(p: Omit<ClipProgress, 'seq'>) {
  progress = { ...p, seq: progress.seq + 1 };
  progressListener?.();
  if (idleTimer) clearTimeout(idleTimer);
  if (p.phase === 'done' || p.phase === 'failed' || p.phase === 'deferred') {
    idleTimer = setTimeout(() => setProgress({ phase: 'idle' }), 12_000);
  }
}

function fail(reason: ClipFailure, notify = true, detail?: string): ClipOutcome {
  if (reason !== 'busy') setProgress({ phase: 'failed', reason, detail });
  if (notify) new Notification({ title: nt('clip.title'), body: nt(`clip.err.${reason}` as MsgKey) + (detail ? ` (${detail})` : '') }).show();
  return { ok: false, reason };
}

/**
 * "Clip that": asks OBS to save its Replay Buffer, uploads the file to the streamer's Trigglow clips (the existing
 * /api/kick/clips/upload — the server converts mkv/flv/ts to MP4 and measures the length) and notifies at each step.
 * The replay file itself stays where OBS wrote it. Clips land in the library as *private* (the streamer publishes
 * them from there) unless the streamer picked another visibility; announced ones are at least unlisted, since their
 * link goes to chat.
 * `deferUpload`: park it in the queue and upload once the stream is over (retryQueuedClips with uploadDeferred).
 */
export async function clipNow(
  obs: EngineLink,
  apiOrigin: string,
  openClips: () => void,
  opts: ClipPrefs & { announce?: boolean; deferUpload?: boolean; account: string | null },
): Promise<ClipOutcome> {
  if (busy) return fail('busy');
  busy = true;
  try {
    if (obs.state !== 'connected') return fail('obs_not_connected');
    if (obs.replayActive !== true) {
      try {
        await obs.startReplayBuffer();
        return fail('replay_started');
      } catch {
        return fail('replay_unavailable');
      }
    }
    setProgress({ phase: 'saving' });
    new Notification({ title: nt('clip.saving'), body: nt('clip.saving.body'), silent: true }).show();
    let file: string;
    try {
      file = await obs.saveReplay();
    } catch {
      return fail('save_failed');
    }
    const capturedAt = Date.now(); // the replay ends now: lets the stream's highlights place this clip
    const ext = path.extname(file).slice(1).toLowerCase();
    const type = MIME[ext];
    if (!type) return fail('unsupported');
    const size = (await fs.stat(file).catch(() => null))?.size ?? 0;
    if (!size) return fail('save_failed');

    const title = (opts.title.trim() || '{game} — {date}').replaceAll('{date}', new Date().toLocaleString()).slice(0, 100);
    const visibility = opts.announce && opts.visibility === 'private' ? 'unlisted' : opts.visibility;
    const meta = { title, announce: opts.announce, visibility, announceText: opts.announceText || undefined, capturedAt, account: opts.account };
    if (opts.deferUpload && !opts.announce) {
      // Encoding now would compete with the game and OBS: the original is parked and shrunk when it uploads, after the stream.
      await enqueue(file, ext, { ...meta, deferred: true, raw: true }, false);
      setProgress({ phase: 'deferred', title });
      new Notification({ title: nt('clip.deferred'), body: nt('clip.deferred.body'), silent: true }).show();
      return { ok: false, reason: 'deferred' };
    }
    setProgress({ phase: 'compressing', title });
    const src = await shrink(file, ext, opts.maxBytes, opts.maxHeight);
    const bytes = src.moved ? (await fs.stat(src.file)).size : size;
    if (bytes > opts.maxBytes) {
      if (src.moved) await fs.rm(src.file, { force: true });
      return fail('too_large', true, tooLargeDetail(bytes, opts.maxBytes, src.note));
    }
    // Park the file in the retry queue before uploading: if the network drops (or the app dies) it goes up later by itself.
    const q = await enqueue(src.file, src.ext, { ...meta, seconds: src.seconds }, src.moved);
    setProgress({ phase: 'uploading', title });
    new Notification({ title: nt('clip.uploading'), silent: true }).show();
    uploading.add(q.id);
    const r = await uploadQueued(q, apiOrigin).finally(() => uploading.delete(q.id));
    if (r.ok) {
      await dropQueued(q);
      return announceDone(r.clip, openClips);
    }
    if (r.retry) {
      fail(r.reason, false, r.detail);
      new Notification({ title: nt('clip.title'), body: nt(r.reason === 'upload_failed' ? 'clip.queued' : (`clip.err.${r.reason}` as MsgKey)) }).show();
      return { ok: false, reason: r.reason };
    }
    await dropQueued(q);
    return fail(r.reason, true, r.detail);
  } catch (err) {
    // Network / unexpected error (e.g. the server closed the connection on a big upload): say what happened.
    const cause = err instanceof Error ? ((err as { cause?: { code?: string } }).cause?.code ?? err.message) : String(err);
    console.warn('[clip] upload error:', err);
    return fail('upload_failed', true, `${cause} · ${new URL(apiOrigin).host}`);
  } finally {
    busy = false;
  }
}

const tooLargeDetail = (bytes: number, max: number, note?: string) =>
  `${Math.round(bytes / 1048576)} MB > ${Math.round(max / 1048576)} MB${note ? ` · ${note}` : ''}`;

/**
 * Re-encodes to a web MP4 sized from the clip's length so it always fits the storage ceiling. If that fails, the
 * original goes up as long as it fits (the server converts mkv/flv/ts itself and measures the length).
 * `moved`: `file` is a temp file of ours (move it in, or delete it); otherwise it is the untouched input.
 */
async function shrink(file: string, ext: string, maxBytes: number, maxHeight: number | null): Promise<{ file: string; ext: string; seconds?: number; moved: boolean; note?: string }> {
  const tmp = path.join(app.getPath('temp'), `trigglow-clip-${Date.now()}.mp4`);
  try {
    const { durationSeconds, encoded } = await compressReplay(file, tmp, maxBytes, maxHeight, (await fs.stat(file)).size);
    // Already web-ready and small enough: OBS's own file goes up, at full quality and with no encode at all.
    if (!encoded) return { file, ext, seconds: durationSeconds, moved: false };
    return { file: tmp, ext: 'mp4', seconds: durationSeconds, moved: true };
  } catch (err) {
    console.warn('[clip] compression skipped:', err instanceof Error ? err.message : err);
    await fs.rm(tmp, { force: true });
    return { file, ext, moved: false, note: 'compression failed' };
  }
}

/** rename, or copy + delete when temp and userData are on different drives. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

function announceDone(clip: { id: string; title: string }, openClips: () => void): ClipOutcome {
  const done = new Notification({ title: nt('clip.done'), body: nt('clip.done.body', { title: clip.title }) });
  setProgress({ phase: 'done', title: clip.title });
  done.on('click', openClips);
  done.show();
  return { ok: true, id: clip.id, title: clip.title };
}

/* ---- retry queue: userData/clip-queue/<id>.json (+ the video next to it) — whatever is there still has to go up ---- */

interface Queued {
  id: string;
  ext: string;
  title: string;
  seconds?: number;
  announce?: boolean;
  /** Missing on older builds: private (announced: public, as the server did then). */
  visibility?: ClipVisibility;
  announceText?: string;
  /** Waits for the end of the stream (or OBS closing) before its first upload attempt. */
  deferred?: boolean;
  /** When OBS saved the replay (ms); missing on clips queued by older builds. */
  capturedAt?: number;
  /** The account (its overlay id) the clip was made on: it never uploads into another one. Missing on older builds. */
  account?: string | null;
  /** Still the original OBS file: re-encode before uploading (deferred clips skip encoding while live). */
  raw?: boolean;
  attempts: number;
  at: number;
}
const QUEUE_MAX_AGE_MS = 24 * 3600_000;
/** A deferred clip waits for the stream to end, which can be a long marathon plus a day of not opening OBS. */
const DEFERRED_MAX_AGE_MS = 7 * 24 * 3600_000;
const QUEUE_MAX_ATTEMPTS = 20;
const queueDir = () => path.join(app.getPath('userData'), 'clip-queue');
const videoOf = (q: Queued) => path.join(queueDir(), `${q.id}.${q.ext}`);

/** `move`: the file is our own temp copy (moved in); otherwise it is OBS's replay, which stays where OBS wrote it. */
async function enqueue(file: string, ext: string, m: Omit<Queued, 'id' | 'ext' | 'attempts' | 'at'>, move: boolean): Promise<Queued> {
  await fs.mkdir(queueDir(), { recursive: true });
  const q: Queued = { id: String(Date.now()), ext, ...m, attempts: 0, at: Date.now() };
  await (move ? moveFile(file, videoOf(q)) : fs.copyFile(file, videoOf(q)));
  await saveQueued(q);
  if (q.deferred) deferredCount += 1;
  return q;
}
/** Written next to it and renamed over, so a crash never leaves a half-written entry. */
async function saveQueued(q: Queued) {
  const file = path.join(queueDir(), `${q.id}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(q));
  await fs.rename(`${file}.tmp`, file);
}
async function readQueued(name: string): Promise<Queued | null> {
  const file = path.join(queueDir(), name);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Queued;
  } catch {
    await fs.rm(file, { force: true }); // unreadable (an older build crashed mid-write): don't let it block the rest
    return null;
  }
}
async function dropQueued(q: Queued) {
  await fs.rm(videoOf(q), { force: true });
  await fs.rm(path.join(queueDir(), `${q.id}.json`), { force: true });
}

type UploadResult =
  | { ok: true; clip: { id: string; title: string } }
  | { ok: false; reason: ClipFailure; detail?: string; retry: boolean };

/** One upload attempt. `retry` = worth trying again later (network down, server hiccup, rate limit). */
async function uploadQueued(q: Queued, apiOrigin: string): Promise<UploadResult> {
  const cookie = (await session.defaultSession.cookies.get({ url: apiOrigin, name: 'trigglow_session' }))[0];
  if (!cookie) return { ok: false, reason: 'not_signed_in', retry: true }; // they may sign in again later
  const host = new URL(apiOrigin).host;
  try {
    const boundary = `----trigglow${Date.now().toString(16)}`;
    const fields = {
      title: q.title,
      ...(q.seconds ? { durationSeconds: String(Math.round(q.seconds)) } : {}),
      ...(q.capturedAt ? { capturedAt: new Date(q.capturedAt).toISOString() } : {}),
      // The server only posts the link in chat for a clip people can open (unlisted/public).
      ...(q.announce ? { announce: '1', ...(q.announceText ? { announceText: q.announceText } : {}) } : {}),
      ...(q.visibility ? { visibility: q.visibility } : q.announce ? {} : { visibility: 'private' }),
    };
    // A file-backed Blob: fetch streams the video from disk instead of holding a copy (up to ~1 GB) in memory.
    const body = buildMultipart(boundary, fields, { name: `clip.${q.ext}`, type: MIME[q.ext] ?? 'application/octet-stream', data: await openAsBlob(videoOf(q)) });
    // Node's fetch (not Chromium's): it streams a Blob body with its length, and the session cookie is sent by hand.
    const res = await fetch(`${apiOrigin}/api/kick/clips/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: `trigglow_session=${cookie.value}` }, // value is stored URL-encoded, as the server expects
      body: body as unknown as BodyInit,
    });
    if (res.ok) return { ok: true, clip: ((await res.json()) as { clip: { id: string; title: string } }).clip };
    const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    const detail = `HTTP ${res.status}${code ? ` · ${code}` : ''} · ${host}`;
    console.warn('[clip] upload failed:', detail);
    if (res.status === 401) return { ok: false, reason: 'not_signed_in', retry: true };
    if (code === 'clips_disabled_by_streamer') return { ok: false, reason: 'clips_disabled', retry: false };
    if (code === 'clip_too_long_for_plan') return { ok: false, reason: 'too_long', retry: false };
    if (res.status === 429) return { ok: false, reason: 'rate_limited', retry: true };
    if (res.status === 415) return { ok: false, reason: 'unsupported', detail, retry: false };
    if (res.status === 413) return { ok: false, reason: 'too_large', detail, retry: false }; // a proxy limit (nginx client_max_body_size) shows up here
    // 404/503: that server has Clips switched off or not configured (a dev/staging server, or an older deploy).
    if (res.status === 404 || res.status === 503) return { ok: false, reason: 'clips_unavailable', detail, retry: false };
    return { ok: false, reason: 'upload_failed', detail, retry: res.status >= 500 };
  } catch (err) {
    // Network error (offline, connection closed on a big upload): say what happened and keep the file.
    const cause = err instanceof Error ? ((err as { cause?: { code?: string } }).cause?.code ?? err.message) : String(err);
    console.warn('[clip] upload error:', err);
    return { ok: false, reason: 'upload_failed', detail: `${cause} · ${host}`, retry: true };
  }
}

let deferredCount = 0;
/** Clips saved on this PC waiting for the stream to end (shown on the Clips card). */
export const getDeferredClipCount = () => deferredCount;

/**
 * Tries every parked clip again (oldest first); stops at the first transient failure so a down server isn't hammered.
 * `uploadDeferred`: OBS isn't streaming/recording (or is closed) — the clips saved for "after the stream" go too.
 */
export async function retryQueuedClips(
  apiOrigin: string,
  openClips: () => void,
  opts: { uploadDeferred: boolean; maxBytes: number; maxHeight: number | null; account: string | null },
): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    const names = (await fs.readdir(queueDir()).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    const queue = (await Promise.all(names.map(readQueued))).filter((q): q is Queued => q !== null && !uploading.has(q.id));
    deferredCount = queue.filter((q) => q.deferred).length;
    const forget = async (q: Queued) => {
      await dropQueued(q);
      if (q.deferred) deferredCount -= 1;
    };
    for (const q of queue) {
      if (Date.now() - q.at > (q.deferred ? DEFERRED_MAX_AGE_MS : QUEUE_MAX_AGE_MS) || q.attempts >= QUEUE_MAX_ATTEMPTS) {
        await forget(q);
        new Notification({ title: nt('clip.title'), body: nt('clip.dropped', { title: q.title }) }).show();
        continue;
      }
      if (q.deferred && !opts.uploadDeferred) continue;
      if (q.account && q.account !== opts.account) continue; // made on another account: waits for it (or expires)
      uploading.add(q.id);
      try {
        if (q.raw) {
          setProgress({ phase: 'compressing', title: q.title });
          const src = await shrink(videoOf(q), q.ext, opts.maxBytes, opts.maxHeight);
          if (src.moved) {
            const old = videoOf(q);
            await moveFile(src.file, path.join(queueDir(), `${q.id}.mp4`));
            Object.assign(q, { ext: 'mp4', seconds: src.seconds, raw: false });
            await saveQueued(q);
            if (old !== videoOf(q)) await fs.rm(old, { force: true });
          } else {
            q.raw = false;
            await saveQueued(q);
          }
          const bytes = (await fs.stat(videoOf(q))).size;
          if (bytes > opts.maxBytes) {
            await forget(q);
            fail('too_large', true, tooLargeDetail(bytes, opts.maxBytes, src.note));
            continue;
          }
        }
        setProgress({ phase: 'uploading', title: q.title });
        const r = await uploadQueued(q, apiOrigin);
        if (r.ok) {
          await forget(q);
          announceDone(r.clip, openClips);
          continue;
        }
        if (r.retry) {
          if (r.reason !== 'not_signed_in') q.attempts++; // signed out isn't the clip's fault: it waits for a sign-in
          await saveQueued(q);
          setProgress({ phase: 'idle' });
          return;
        }
        await forget(q);
        fail(r.reason, true, r.detail);
      } finally {
        uploading.delete(q.id);
      }
    }
    setProgress({ phase: 'idle' });
  } finally {
    retrying = false;
  }
}
