import { useSyncExternalStore } from 'react'

/* Language and time zone for the whole interface.
 *
 * The navigation, sign-in pages and public pages are translated. Screens deeper inside the app
 * fall back to English until their strings are added to the dictionaries below.
 */

export const LANGUAGES = [
  { key: 'en', label: 'English' },
  { key: 'hi', label: 'हिन्दी' },
  { key: 'ta', label: 'தமிழ்' },
  { key: 'es', label: 'Español' },
  { key: 'fr', label: 'Français' },
  { key: 'de', label: 'Deutsch' },
]

const en = {
  'nav.dashboard': 'Dashboard',
  'nav.projects': 'Projects',
  'nav.roadmap': 'Roadmap',
  'nav.calendar': 'Calendar',
  'nav.myIssues': 'My issues',
  'nav.portfolio': 'Portfolio',
  'nav.workload': 'Workload',
  'nav.timesheet': 'Timesheet',
  'nav.chat': 'Chat',
  'nav.users': 'Users',
  'nav.billing': 'Billing',
  'nav.settings': 'Workspace settings',
  'nav.support': 'Help and support',
  'nav.owner': 'Owner console',
  'nav.trash': 'Recycle bin',
  'nav.collapse': 'Collapse',
  'nav.signOut': 'Sign out',
  'top.search': 'Search projects…',
  'top.commands': 'Commands',
  'auth.welcome': 'Welcome back',
  'auth.welcomeSub': 'Sign in to keep your projects moving.',
  'auth.username': 'Username or email',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.forgot': 'Forgot your password?',
  'auth.workspace': 'Workspace ID',
  'auth.findWorkspace': 'Forgot your workspace ID?',
  'auth.new': 'New here?',
  'auth.create': 'Create a workspace',
  'auth.createTitle': 'Create your workspace',
  'auth.company': 'Company or team name',
  'auth.yourName': 'Your name',
  'auth.email': 'Work email',
  'auth.usernameOnly': 'Username',
  'auth.start': 'Start free trial',
  'auth.have': 'Already have an account?',
  'auth.agree': 'I agree to the',
  'auth.terms': 'terms of service',
  'auth.and': 'and the',
  'auth.privacy': 'privacy policy',
  'land.signIn': 'Sign in',
  'land.start': 'Start free trial',
  'land.pricing': 'Pricing',
  'land.features': 'Features',
  'land.noCard': 'No payment details needed.',
  'land.everything': 'Everything a team needs to deliver',
  'land.plansTitle': 'Simple pricing, per user',
  'land.perUserMonth': 'per user / month',
  'land.ready': 'Ready to try it with your team?',
  'common.language': 'Language',
  'common.timezone': 'Time zone',
}

const dictionaries = {
  en,
  hi: {
    'nav.dashboard': 'डैशबोर्ड', 'nav.projects': 'प्रोजेक्ट', 'nav.roadmap': 'रोडमैप', 'nav.calendar': 'कैलेंडर',
    'nav.myIssues': 'मेरे कार्य', 'nav.portfolio': 'पोर्टफोलियो', 'nav.workload': 'कार्यभार', 'nav.timesheet': 'टाइमशीट',
    'nav.chat': 'चैट', 'nav.users': 'उपयोगकर्ता', 'nav.billing': 'बिलिंग', 'nav.settings': 'वर्कस्पेस सेटिंग्स', 'nav.support': 'सहायता', 'nav.owner': 'ओनर कंसोल',
    'nav.trash': 'रीसायकल बिन', 'nav.collapse': 'छोटा करें', 'nav.signOut': 'साइन आउट',
    'top.search': 'प्रोजेक्ट खोजें…', 'top.commands': 'कमांड',
    'auth.welcome': 'वापसी पर स्वागत है', 'auth.welcomeSub': 'अपने प्रोजेक्ट आगे बढ़ाने के लिए साइन इन करें।',
    'auth.username': 'उपयोगकर्ता नाम या ईमेल', 'auth.password': 'पासवर्ड', 'auth.signIn': 'साइन इन', 'auth.forgot': 'पासवर्ड भूल गए?',
    'auth.workspace': 'वर्कस्पेस आईडी', 'auth.findWorkspace': 'वर्कस्पेस आईडी भूल गए?',
    'auth.new': 'नए हैं?', 'auth.create': 'वर्कस्पेस बनाएँ', 'auth.createTitle': 'अपना वर्कस्पेस बनाएँ',
    'auth.company': 'कंपनी या टीम का नाम', 'auth.yourName': 'आपका नाम', 'auth.email': 'कार्य ईमेल', 'auth.usernameOnly': 'उपयोगकर्ता नाम',
    'auth.start': 'मुफ़्त ट्रायल शुरू करें', 'auth.have': 'पहले से खाता है?', 'auth.agree': 'मैं सहमत हूँ:',
    'auth.terms': 'सेवा की शर्तें', 'auth.and': 'और', 'auth.privacy': 'गोपनीयता नीति',
    'land.signIn': 'साइन इन', 'land.start': 'मुफ़्त ट्रायल शुरू करें', 'land.pricing': 'मूल्य', 'land.features': 'सुविधाएँ',
    'land.noCard': 'भुगतान विवरण की ज़रूरत नहीं।', 'land.everything': 'टीम को काम पूरा करने के लिए जो कुछ चाहिए',
    'land.plansTitle': 'सरल मूल्य, प्रति उपयोगकर्ता', 'land.perUserMonth': 'प्रति उपयोगकर्ता / माह', 'land.ready': 'अपनी टीम के साथ आज़माने के लिए तैयार?',
    'common.language': 'भाषा', 'common.timezone': 'समय क्षेत्र',
  },
  ta: {
    'nav.dashboard': 'முகப்பு', 'nav.projects': 'திட்டங்கள்', 'nav.roadmap': 'வழித்திட்டம்', 'nav.calendar': 'நாட்காட்டி',
    'nav.myIssues': 'என் பணிகள்', 'nav.portfolio': 'போர்ட்ஃபோலியோ', 'nav.workload': 'பணிச்சுமை', 'nav.timesheet': 'நேரப்பதிவு',
    'nav.chat': 'அரட்டை', 'nav.users': 'பயனர்கள்', 'nav.billing': 'கட்டணம்', 'nav.settings': 'பணியிட அமைப்புகள்', 'nav.support': 'உதவி', 'nav.owner': 'உரிமையாளர் பலகம்',
    'nav.trash': 'மறுசுழற்சி தொட்டி', 'nav.collapse': 'சுருக்கு', 'nav.signOut': 'வெளியேறு',
    'top.search': 'திட்டங்களைத் தேடு…', 'top.commands': 'கட்டளைகள்',
    'auth.welcome': 'மீண்டும் வரவேற்கிறோம்', 'auth.welcomeSub': 'உங்கள் திட்டங்களைத் தொடர உள்நுழையவும்.',
    'auth.username': 'பயனர்பெயர் அல்லது மின்னஞ்சல்', 'auth.password': 'கடவுச்சொல்', 'auth.signIn': 'உள்நுழை', 'auth.forgot': 'கடவுச்சொல் மறந்துவிட்டதா?',
    'auth.workspace': 'பணியிட ஐடி', 'auth.findWorkspace': 'பணியிட ஐடி மறந்துவிட்டதா?',
    'auth.new': 'புதியவரா?', 'auth.create': 'பணியிடம் உருவாக்கு', 'auth.createTitle': 'உங்கள் பணியிடத்தை உருவாக்குங்கள்',
    'auth.company': 'நிறுவனம் அல்லது குழுவின் பெயர்', 'auth.yourName': 'உங்கள் பெயர்', 'auth.email': 'பணி மின்னஞ்சல்', 'auth.usernameOnly': 'பயனர்பெயர்',
    'auth.start': 'இலவச சோதனையைத் தொடங்கு', 'auth.have': 'ஏற்கனவே கணக்கு உள்ளதா?', 'auth.agree': 'நான் ஒப்புக்கொள்கிறேன்:',
    'auth.terms': 'சேவை விதிமுறைகள்', 'auth.and': 'மற்றும்', 'auth.privacy': 'தனியுரிமைக் கொள்கை',
    'land.signIn': 'உள்நுழை', 'land.start': 'இலவச சோதனையைத் தொடங்கு', 'land.pricing': 'விலை', 'land.features': 'அம்சங்கள்',
    'land.noCard': 'கட்டண விவரங்கள் தேவையில்லை.', 'land.everything': 'ஒரு குழு பணியை முடிக்கத் தேவையான அனைத்தும்',
    'land.plansTitle': 'எளிய விலை, ஒரு பயனருக்கு', 'land.perUserMonth': 'ஒரு பயனருக்கு / மாதம்', 'land.ready': 'உங்கள் குழுவுடன் முயற்சிக்கத் தயாரா?',
    'common.language': 'மொழி', 'common.timezone': 'நேர மண்டலம்',
  },
  es: {
    'nav.dashboard': 'Panel', 'nav.projects': 'Proyectos', 'nav.roadmap': 'Hoja de ruta', 'nav.calendar': 'Calendario',
    'nav.myIssues': 'Mis tareas', 'nav.portfolio': 'Cartera', 'nav.workload': 'Carga de trabajo', 'nav.timesheet': 'Horas',
    'nav.chat': 'Chat', 'nav.users': 'Usuarios', 'nav.billing': 'Facturación', 'nav.settings': 'Ajustes del espacio', 'nav.support': 'Ayuda y soporte', 'nav.owner': 'Consola del propietario',
    'nav.trash': 'Papelera', 'nav.collapse': 'Contraer', 'nav.signOut': 'Cerrar sesión',
    'top.search': 'Buscar proyectos…', 'top.commands': 'Comandos',
    'auth.welcome': 'Bienvenido de nuevo', 'auth.welcomeSub': 'Inicia sesión para seguir con tus proyectos.',
    'auth.username': 'Usuario o correo', 'auth.password': 'Contraseña', 'auth.signIn': 'Iniciar sesión', 'auth.forgot': '¿Olvidaste tu contraseña?',
    'auth.workspace': 'ID del espacio de trabajo', 'auth.findWorkspace': '¿Olvidaste el ID del espacio de trabajo?',
    'auth.new': '¿Eres nuevo?', 'auth.create': 'Crear un espacio de trabajo', 'auth.createTitle': 'Crea tu espacio de trabajo',
    'auth.company': 'Nombre de la empresa o equipo', 'auth.yourName': 'Tu nombre', 'auth.email': 'Correo de trabajo', 'auth.usernameOnly': 'Usuario',
    'auth.start': 'Empezar prueba gratuita', 'auth.have': '¿Ya tienes una cuenta?', 'auth.agree': 'Acepto los',
    'auth.terms': 'términos del servicio', 'auth.and': 'y la', 'auth.privacy': 'política de privacidad',
    'land.signIn': 'Iniciar sesión', 'land.start': 'Empezar prueba gratuita', 'land.pricing': 'Precios', 'land.features': 'Funciones',
    'land.noCard': 'No se necesitan datos de pago.', 'land.everything': 'Todo lo que un equipo necesita para entregar',
    'land.plansTitle': 'Precios sencillos, por usuario', 'land.perUserMonth': 'por usuario / mes', 'land.ready': '¿Listo para probarlo con tu equipo?',
    'common.language': 'Idioma', 'common.timezone': 'Zona horaria',
  },
  fr: {
    'nav.dashboard': 'Tableau de bord', 'nav.projects': 'Projets', 'nav.roadmap': 'Feuille de route', 'nav.calendar': 'Calendrier',
    'nav.myIssues': 'Mes tâches', 'nav.portfolio': 'Portefeuille', 'nav.workload': 'Charge de travail', 'nav.timesheet': 'Feuille de temps',
    'nav.chat': 'Discussion', 'nav.users': 'Utilisateurs', 'nav.billing': 'Facturation', 'nav.settings': "Paramètres de l'espace", 'nav.support': 'Aide et support', 'nav.owner': 'Console propriétaire',
    'nav.trash': 'Corbeille', 'nav.collapse': 'Réduire', 'nav.signOut': 'Se déconnecter',
    'top.search': 'Rechercher des projets…', 'top.commands': 'Commandes',
    'auth.welcome': 'Bon retour', 'auth.welcomeSub': 'Connectez-vous pour faire avancer vos projets.',
    'auth.username': "Nom d'utilisateur ou e-mail", 'auth.password': 'Mot de passe', 'auth.signIn': 'Se connecter', 'auth.forgot': 'Mot de passe oublié ?',
    'auth.workspace': "ID de l'espace de travail", 'auth.findWorkspace': "ID de l'espace de travail oublié ?",
    'auth.new': 'Nouveau ici ?', 'auth.create': 'Créer un espace de travail', 'auth.createTitle': 'Créez votre espace de travail',
    'auth.company': "Nom de l'entreprise ou de l'équipe", 'auth.yourName': 'Votre nom', 'auth.email': 'E-mail professionnel', 'auth.usernameOnly': "Nom d'utilisateur",
    'auth.start': "Commencer l'essai gratuit", 'auth.have': 'Vous avez déjà un compte ?', 'auth.agree': "J'accepte les",
    'auth.terms': "conditions d'utilisation", 'auth.and': 'et la', 'auth.privacy': 'politique de confidentialité',
    'land.signIn': 'Se connecter', 'land.start': "Commencer l'essai gratuit", 'land.pricing': 'Tarifs', 'land.features': 'Fonctionnalités',
    'land.noCard': 'Aucune information de paiement requise.', 'land.everything': "Tout ce dont une équipe a besoin pour livrer",
    'land.plansTitle': 'Des tarifs simples, par utilisateur', 'land.perUserMonth': 'par utilisateur / mois', 'land.ready': "Prêt à l'essayer avec votre équipe ?",
    'common.language': 'Langue', 'common.timezone': 'Fuseau horaire',
  },
  de: {
    'nav.dashboard': 'Übersicht', 'nav.projects': 'Projekte', 'nav.roadmap': 'Roadmap', 'nav.calendar': 'Kalender',
    'nav.myIssues': 'Meine Aufgaben', 'nav.portfolio': 'Portfolio', 'nav.workload': 'Auslastung', 'nav.timesheet': 'Zeiterfassung',
    'nav.chat': 'Chat', 'nav.users': 'Benutzer', 'nav.billing': 'Abrechnung', 'nav.settings': 'Arbeitsbereich-Einstellungen', 'nav.support': 'Hilfe und Support', 'nav.owner': 'Betreiberkonsole',
    'nav.trash': 'Papierkorb', 'nav.collapse': 'Einklappen', 'nav.signOut': 'Abmelden',
    'top.search': 'Projekte suchen…', 'top.commands': 'Befehle',
    'auth.welcome': 'Willkommen zurück', 'auth.welcomeSub': 'Melden Sie sich an, um Ihre Projekte voranzubringen.',
    'auth.username': 'Benutzername oder E-Mail', 'auth.password': 'Passwort', 'auth.signIn': 'Anmelden', 'auth.forgot': 'Passwort vergessen?',
    'auth.workspace': 'Arbeitsbereich-ID', 'auth.findWorkspace': 'Arbeitsbereich-ID vergessen?',
    'auth.new': 'Neu hier?', 'auth.create': 'Arbeitsbereich erstellen', 'auth.createTitle': 'Erstellen Sie Ihren Arbeitsbereich',
    'auth.company': 'Name des Unternehmens oder Teams', 'auth.yourName': 'Ihr Name', 'auth.email': 'Geschäftliche E-Mail', 'auth.usernameOnly': 'Benutzername',
    'auth.start': 'Kostenlos testen', 'auth.have': 'Sie haben bereits ein Konto?', 'auth.agree': 'Ich akzeptiere die',
    'auth.terms': 'Nutzungsbedingungen', 'auth.and': 'und die', 'auth.privacy': 'Datenschutzerklärung',
    'land.signIn': 'Anmelden', 'land.start': 'Kostenlos testen', 'land.pricing': 'Preise', 'land.features': 'Funktionen',
    'land.noCard': 'Keine Zahlungsdaten erforderlich.', 'land.everything': 'Alles, was ein Team zum Liefern braucht',
    'land.plansTitle': 'Einfache Preise, pro Benutzer', 'land.perUserMonth': 'pro Benutzer / Monat', 'land.ready': 'Bereit, es mit Ihrem Team zu testen?',
    'common.language': 'Sprache', 'common.timezone': 'Zeitzone',
  },
}

const read = (key) => {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

let language = dictionaries[read('pm_lang')] ? read('pm_lang') : 'en'
let timeZone = read('pm_tz')
const listeners = new Set()

const validZone = (zone) => {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}
if (!validZone(timeZone)) timeZone = ''

/** Apply a person's choices (or the workspace default for the time zone). */
export function setLocale({ language: nextLanguage, timeZone: nextZone }) {
  const lang = dictionaries[nextLanguage] ? nextLanguage : language
  const zone = nextZone === undefined ? timeZone : validZone(nextZone) ? nextZone : ''
  if (lang === language && zone === timeZone) return
  language = lang
  timeZone = zone
  try {
    localStorage.setItem('pm_lang', language)
    localStorage.setItem('pm_tz', timeZone)
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = language
  listeners.forEach((fn) => fn())
}

export const getLanguage = () => language
export const getTimeZone = () => timeZone

/** Options for toLocale*String so every instant is shown in the chosen language and zone. */
export const localeTag = () => (language === 'en' ? undefined : language)
export const withZone = (options = {}) => (timeZone ? { ...options, timeZone } : options)

export const t = (key) => dictionaries[language]?.[key] ?? en[key] ?? key

const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-renders the component when the language or time zone changes; returns the translate function. */
export function useT() {
  useSyncExternalStore(subscribe, () => `${language}|${timeZone}`)
  return t
}

export function timeZones() {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore', 'Australia/Sydney']
  }
}
