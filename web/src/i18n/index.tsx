import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';

export type Locale = 'zh-CN' | 'en';
export type { MessageKey };

const STORAGE_KEY = 'crp_locale';

const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  en,
};

function detectInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh-CN';
    if (lang) return 'en';
  }
  return 'zh-CN';
}

let activeLocale: Locale = detectInitialLocale();

export function getLocale(): Locale {
  return activeLocale;
}

export function translate(
  key: MessageKey,
  params?: Record<string, string | number>,
  locale: Locale = activeLocale
): string {
  const template = MESSAGES[locale][key] ?? MESSAGES['zh-CN'][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`
  );
}

export function formatDateTime(
  value: string | null | undefined,
  locale: Locale = activeLocale
): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  formatTime: (value: string | null | undefined) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    activeLocale = next;
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    activeLocale = locale;
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => translate(key, params, locale),
    [locale]
  );

  const formatTime = useCallback(
    (value: string | null | undefined) => formatDateTime(value, locale),
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, formatTime }),
    [locale, setLocale, t, formatTime]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className={`lang-switch${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={t('common.switchLanguage')}
    >
      <button
        type="button"
        className={`lang-btn${locale === 'zh-CN' ? ' active' : ''}`}
        aria-pressed={locale === 'zh-CN'}
        onClick={() => setLocale('zh-CN')}
      >
        中文
      </button>
      <button
        type="button"
        className={`lang-btn${locale === 'en' ? ' active' : ''}`}
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
      >
        EN
      </button>
    </div>
  );
}
