import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/translation.json';
import ar from './locales/ar/translation.json';
import es from './locales/es/translation.json';
import pt from './locales/pt/translation.json';

const SUPPORTED_LANGUAGES = ['en', 'ar', 'es', 'pt'] as const;
const storedLang = localStorage.getItem('opdesk-lang');
const savedLang = SUPPORTED_LANGUAGES.includes(storedLang as (typeof SUPPORTED_LANGUAGES)[number])
  ? storedLang!
  : 'en';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
      es: { translation: es },
      pt: { translation: pt },
    },
    lng: savedLang,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

/** Persist language choice and update document direction */
export function setLanguage(lang: string) {
  i18n.changeLanguage(lang);
  localStorage.setItem('opdesk-lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

// Apply direction on load
document.documentElement.lang = savedLang;
document.documentElement.dir = savedLang === 'ar' ? 'rtl' : 'ltr';

export default i18n;
