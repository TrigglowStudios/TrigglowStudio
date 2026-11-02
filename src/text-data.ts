import { session } from 'electron';
import { formatMoney, type TextData, type Widget } from './text-sources';

async function getJson<T>(url: string): Promise<T> {
  const res = await session.defaultSession.fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface ActivityItem {
  viewerName?: string | null;
  amount?: string | null;
  currency?: string | null;
}

/**
 * What the OBS text sources mirror, from the same endpoints the dashboard already uses: the activity feed for
 * "latest follower / subscriber / donation" (session cookie) and the overlay widgets snapshot for quests & goals.
 */
export async function fetchTextData(
  apiOrigin: string,
  overlayId: string | null,
  need: { follower: boolean; sub: boolean; donation: boolean },
  locale: string,
): Promise<TextData> {
  if (!overlayId) return { follower: null, sub: null, donation: null, widgets: [] };
  const latest = async (kind: string): Promise<ActivityItem | null> =>
    (await getJson<{ items?: ActivityItem[] }>(`${apiOrigin}/api/activity?kind=${kind}&limit=1&days=90`)).items?.[0] ?? null;
  const lower = locale.toLowerCase();
  const anon = lower.startsWith('es')
    ? 'Anónimo'
    : lower.startsWith('pt')
      ? 'Anônimo'
      : lower.startsWith('fr')
        ? 'Anonyme'
        : lower.startsWith('de')
          ? 'Anonym'
          : lower.startsWith('it')
            ? 'Anonimo'
            : lower.startsWith('zh')
              ? '匿名'
              : 'Anonymous';
  const ANON_EXTRA: Record<string, string> = { ru: 'Аноним', ko: '익명', ja: '匿名', hi: 'अनाम', ca: 'Anònim', uk: 'Анонім', eu: 'Anonimoa', gl: 'Anónimo' };
  const anonName = ANON_EXTRA[lower.slice(0, 2)] ?? anon;

  const [follower, sub, donation, snapshot] = await Promise.all([
    need.follower ? latest('follow') : null,
    need.sub ? latest('sub') : null,
    need.donation ? latest('payment') : null,
    getJson<{ widgets?: (Widget & { kind?: string })[]; currency?: string }>(`${apiOrigin}/api/overlay/${encodeURIComponent(overlayId)}/widgets`),
  ]);

  return {
    follower: follower?.viewerName || null,
    sub: sub?.viewerName || null,
    donation: donation
      ? { name: donation.viewerName || anonName, amount: donation.amount ? formatMoney(Math.round(Number(donation.amount) * 100), donation.currency ?? snapshot.currency ?? 'eur', locale) : '' }
      : null,
    widgets: (snapshot.widgets ?? [])
      .filter((w) => w.kind === 'quest' || w.kind === 'goal')
      .map((w) => ({ widgetId: w.widgetId, kind: w.kind, title: w.title, current: w.current, target: w.target, ratio: w.ratio, metric: w.metric, currency: w.currency ?? snapshot.currency })),
  };
}
