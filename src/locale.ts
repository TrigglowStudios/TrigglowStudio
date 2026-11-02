/** Languages the app ships (same set as the web dashboard and assets/i18n.js). */
export const APP_LOCALES = ['en', 'es', 'pt-BR', 'zh', 'fr', 'it', 'de', 'ru', 'ko', 'ja', 'hi', 'ca', 'uk', 'ca-valencia', 'eu', 'gl'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** Any language tag ('fr-CA', 'pt_PT', 'zh-Hans', 'EN') → one the app ships; null when it is none of them. */
export function toAppLocale(raw: unknown): AppLocale | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('pt')) return 'pt-BR';
  if (s.startsWith('zh')) return 'zh';
  if (s.startsWith('fr')) return 'fr';
  if (s.startsWith('it')) return 'it';
  if (s.startsWith('de')) return 'de';
  if (s.startsWith('ru')) return 'ru';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('hi')) return 'hi';
  if (s.startsWith('ca') && s.includes('valencia')) return 'ca-valencia';
  if (s.startsWith('ca')) return 'ca';
  if (s.startsWith('eu')) return 'eu';
  if (s.startsWith('gl')) return 'gl';
  if (s.startsWith('uk')) return 'uk';
  if (s.startsWith('en')) return 'en';
  return null;
}

/** What config.json keeps about the language (Prefs.locale / Prefs.localePending). */
export interface LocalePrefs {
  /** Last language picked in the app or known for the account; null = never, follow the OS. */
  locale: AppLocale | null;
  /** `locale` was picked here and has not reached the account yet (picked while signed out, or the save failed). */
  localePending: boolean;
}

/**
 * The app's language, strongest first:
 * 1. a pick made in this app that the account has not got yet (the newest choice of all);
 * 2. the signed-in account's language (users.locale — what the web dashboard and the server-rendered toasts use);
 * 3. the last language picked or seen here (also what the signed-out screens keep showing);
 * 4. the OS language; 5. English.
 */
export function pickLocale(prefs: LocalePrefs, account: AppLocale | null, os: string | null | undefined): AppLocale {
  if (prefs.locale && prefs.localePending) return prefs.locale;
  return account ?? prefs.locale ?? toAppLocale(os) ?? 'en';
}

/**
 * Signed in and the account's language just became known. A pick still waiting is to be saved to the account
 * (`push`; clear `localePending` once that worked); otherwise the account's language is remembered for next time.
 * `accountJustChanged`: the user changed it right now (the web dashboard's language menu), so it beats a waiting pick.
 */
export function reconcileAccountLocale(
  prefs: LocalePrefs,
  account: AppLocale | null,
  accountJustChanged = false,
): { prefs: LocalePrefs; push: AppLocale | null } {
  if (prefs.locale && prefs.localePending && !accountJustChanged) {
    return prefs.locale === account ? { prefs: { locale: account, localePending: false }, push: null } : { prefs, push: prefs.locale };
  }
  if (account && (account !== prefs.locale || prefs.localePending)) return { prefs: { locale: account, localePending: false }, push: null };
  return { prefs, push: null };
}
