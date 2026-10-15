// src/controllers/marketingPresets.ts
// Modèles prêts à publier (campagnes, bannières, réseaux sociaux) et automatisations préenregistrées.
// Tout est modifiable depuis l'interface ; les modèles d'origine peuvent être restaurés.
import { query } from "../config/database";

type B = Record<string, any>;
const h = (text: string): B => ({ type: "heading", text });
const p = (text: string): B => ({ type: "text", text });
const btn = (label: string, url: string): B => ({ type: "button", label, url });
const course = (): B => ({ type: "course", course_id: null });
const webinar = (): B => ({ type: "webinar", bootcamp_id: null });
const coupon = (code: string, text: string): B => ({ type: "coupon", code, text });
const hr = (): B => ({ type: "divider" });

interface Lang { name: string; description: string; subject: string; preheader: string; social: string; blocks: B[] }
interface Tpl {
  slug: string; icon: string; category: "offer" | "event" | "content" | "retention" | "seasonal" | "growth";
  kind: "newsletter" | "offer" | "webinar" | "announcement";
  audience?: B; promo?: B; coupon?: B; banner_tone?: string; fr: Lang; en: Lang;
}

export const TEMPLATE_PRESETS: Tpl[] = [
  // ───────────── Offres ─────────────
  {
    slug: "free_course", icon: "Gift", category: "offer", kind: "offer", audience: { roles: ["student"] }, promo: { type: "free", days: 3 }, banner_tone: "success",
    fr: { name: "Cours gratuit — durée limitée", description: "Offrez un cours pendant 72 h. Le prix revient seul à la normale.", subject: "🎁 {{first_name}}, un cours offert pendant 72 h", preheader: "Offre limitée : inscrivez-vous avant la fin.", social: "🎁 Cours gratuit pendant 72 h sur DevOpsAkademy ! Profitez-en avant la fin de l'offre.",
      blocks: [h("Un cours offert, rien que pour vous"), p("Bonjour {{first_name}},\n\nPendant 72 heures seulement, ce cours est entièrement gratuit. Inscrivez-vous maintenant et apprenez à votre rythme, avec accès au contenu complet."), course(), btn("Je profite de l'offre", "/courses"), p("L'offre se termine automatiquement : ne tardez pas !")] },
    en: { name: "Free course — limited time", description: "Give a course away for 72 hours. The price returns to normal on its own.", subject: "🎁 {{first_name}}, a free course for 72 hours", preheader: "Limited offer: enrol before it ends.", social: "🎁 Free course for 72 hours on DevOpsAkademy! Grab it before the offer ends.",
      blocks: [h("A free course, just for you"), p("Hello {{first_name}},\n\nFor 72 hours only, this course is completely free. Enrol now and learn at your own pace, with access to the full content."), course(), btn("Get the offer", "/courses"), p("The offer ends automatically — don't wait!")] },
  },
  {
    slug: "half_price", icon: "Percent", category: "offer", kind: "offer", audience: { roles: ["student"] }, promo: { type: "percent", percent: 50, days: 3 }, banner_tone: "promo",
    fr: { name: "Moitié prix (-50 %)", description: "Divisez le prix d'un cours par deux pendant 72 h.", subject: "-50 % sur votre prochain cours, {{first_name}}", preheader: "Le prix est divisé par deux pendant 72 h.", social: "🔥 -50 % sur un cours DevOpsAkademy pendant 72 h seulement !",
      blocks: [h("Le prix divisé par deux"), p("Bonjour {{first_name}},\n\nPendant 72 heures, ce cours est à moitié prix. C'est le bon moment pour passer à l'action et décrocher une compétence très demandée."), course(), btn("Profiter de -50 %", "/courses"), p("Retour au prix normal à la fin de l'offre.")] },
    en: { name: "Half price (-50%)", description: "Cut a course's price in half for 72 hours.", subject: "-50% on your next course, {{first_name}}", preheader: "The price is cut in half for 72 hours.", social: "🔥 -50% on a DevOpsAkademy course for 72 hours only!",
      blocks: [h("Half the price"), p("Hello {{first_name}},\n\nFor 72 hours, this course is half price. Now is the time to act and earn a highly sought-after skill."), course(), btn("Get -50%", "/courses"), p("Back to the regular price when the offer ends.")] },
  },
  {
    slug: "flash_sale", icon: "Zap", category: "offer", kind: "offer", audience: { roles: ["student"] }, promo: { type: "percent", percent: 30, days: 1 }, banner_tone: "urgent",
    fr: { name: "Vente flash 24 h", description: "Une réduction courte avec un fort sentiment d'urgence.", subject: "⚡ Vente flash : 24 h pour en profiter", preheader: "-30 % jusqu'à demain.", social: "⚡ Vente flash 24 h sur DevOpsAkademy : -30 % sur un cours !",
      blocks: [h("⚡ Vente flash — 24 heures seulement"), p("Bonjour {{first_name}},\n\n-30 % sur ce cours jusqu'à demain. Ensuite, retour au prix normal."), course(), btn("J'en profite maintenant", "/courses")] },
    en: { name: "24-hour flash sale", description: "A short discount with a strong sense of urgency.", subject: "⚡ Flash sale: 24 hours only", preheader: "-30% until tomorrow.", social: "⚡ 24-hour flash sale on DevOpsAkademy: -30% on a course!",
      blocks: [h("⚡ Flash sale — 24 hours only"), p("Hello {{first_name}},\n\n-30% on this course until tomorrow. Then back to the regular price."), course(), btn("Get it now", "/courses")] },
  },
  {
    slug: "welcome_code", icon: "Ticket", category: "offer", kind: "offer", audience: { roles: ["student"], new_days: 14, never_enrolled: true }, coupon: { code: "BIENVENUE20", percent: 20, days: 14 }, banner_tone: "promo",
    fr: { name: "Code de bienvenue (-20 %)", description: "Un code promo pour inciter les nouveaux inscrits à suivre leur premier cours.", subject: "{{first_name}}, -20 % sur votre premier cours", preheader: "Votre code de bienvenue est dedans.", social: "",
      blocks: [h("Bienvenue sur DevOpsAkademy 👋"), p("Bonjour {{first_name}},\n\nPour fêter votre arrivée, voici un code de réduction sur votre premier cours. Il est valable 14 jours."), coupon("BIENVENUE20", "Saisissez ce code au moment du paiement"), course(), btn("Choisir mon premier cours", "/courses")] },
    en: { name: "Welcome code (-20%)", description: "A promo code to encourage new sign-ups to take their first course.", subject: "{{first_name}}, -20% on your first course", preheader: "Your welcome code is inside.", social: "",
      blocks: [h("Welcome to DevOpsAkademy 👋"), p("Hello {{first_name}},\n\nTo celebrate your arrival, here is a discount code for your first course. It is valid for 14 days."), coupon("BIENVENUE20", "Enter this code at checkout"), course(), btn("Pick my first course", "/courses")] },
  },
  // ───────────── Événements ─────────────
  {
    slug: "webinar", icon: "Video", category: "event", kind: "webinar", audience: { roles: ["student", "instructor"] }, banner_tone: "info",
    fr: { name: "Invitation à un webinaire", description: "Invitez vos inscrits à un live ou à un webinaire.", subject: "📅 Webinaire en direct : réservez votre place", preheader: "Places limitées — inscription gratuite.", social: "📅 Webinaire en direct sur DevOpsAkademy — réservez votre place !",
      blocks: [h("Rejoignez-nous en direct"), p("Bonjour {{first_name}},\n\nNous organisons un webinaire en direct. Posez vos questions à nos experts et repartez avec des conseils concrets."), webinar(), p("Un rappel vous sera envoyé avant le début.")] },
    en: { name: "Webinar invitation", description: "Invite your subscribers to a live session or webinar.", subject: "📅 Live webinar: save your seat", preheader: "Limited seats — free registration.", social: "📅 Live webinar on DevOpsAkademy — save your seat!",
      blocks: [h("Join us live"), p("Hello {{first_name}},\n\nWe are hosting a live webinar. Ask our experts your questions and leave with practical advice."), webinar(), p("A reminder will be sent before it starts.")] },
  },
  {
    slug: "webinar_replay", icon: "PlayCircle", category: "event", kind: "webinar", audience: { roles: ["student"] }, banner_tone: "info",
    fr: { name: "Replay du webinaire", description: "Envoyez le replay à ceux qui n'ont pas pu y assister.", subject: "▶️ Le replay du webinaire est disponible", preheader: "Vous l'avez manqué ? Regardez-le quand vous voulez.", social: "▶️ Le replay de notre webinaire est en ligne !",
      blocks: [h("Le replay est disponible"), p("Bonjour {{first_name}},\n\nVous n'avez pas pu suivre le webinaire en direct ? Pas de souci : le replay est disponible, avec toutes les démonstrations."), webinar(), btn("Voir le replay", "/bootcamps")] },
    en: { name: "Webinar replay", description: "Send the replay to those who couldn't attend.", subject: "▶️ The webinar replay is available", preheader: "Missed it? Watch it whenever you want.", social: "▶️ The replay of our webinar is online!",
      blocks: [h("The replay is available"), p("Hello {{first_name}},\n\nCouldn't attend the live webinar? No problem: the replay is available, with all the demos."), webinar(), btn("Watch the replay", "/bootcamps")] },
  },
  // ───────────── Contenu ─────────────
  {
    slug: "new_course", icon: "Sparkles", category: "content", kind: "announcement", audience: { roles: ["student"] }, banner_tone: "promo",
    fr: { name: "Nouveau cours disponible", description: "Annoncez la publication d'un nouveau cours.", subject: "🆕 Un nouveau cours vient d'arriver", preheader: "Découvrez-le dès maintenant.", social: "🆕 Nouveau cours sur DevOpsAkademy — découvrez-le !",
      blocks: [h("Nouveau sur DevOpsAkademy"), p("Bonjour {{first_name}},\n\nUn nouveau cours vient d'être publié. Voici ce qu'il vous apportera : des projets concrets, des exercices corrigés et un certificat à la fin."), course(), btn("Découvrir le cours", "/courses")] },
    en: { name: "New course available", description: "Announce the release of a new course.", subject: "🆕 A new course has just landed", preheader: "Discover it now.", social: "🆕 New course on DevOpsAkademy — check it out!",
      blocks: [h("New on DevOpsAkademy"), p("Hello {{first_name}},\n\nA new course has just been published. Here is what it will bring you: hands-on projects, solved exercises and a certificate at the end."), course(), btn("Discover the course", "/courses")] },
  },
  {
    slug: "newsletter", icon: "Newspaper", category: "content", kind: "newsletter", audience: { roles: ["student", "instructor"] }, banner_tone: "info",
    fr: { name: "Newsletter du mois", description: "Cours à la une, conseil du mois et événements.", subject: "Les nouveautés DevOpsAkademy du mois", preheader: "Cours, conseils et événements à ne pas manquer.", social: "📰 La newsletter DevOpsAkademy du mois est là !",
      blocks: [h("Les nouveautés du mois"), p("Bonjour {{first_name}},\n\nVoici ce qu'il faut retenir ce mois-ci sur la plateforme."), hr(), h("À la une"), course(), hr(), h("Notre conseil du mois"), p("Écrivez ici un conseil pratique ou une actualité DevOps."), btn("Voir tous les cours", "/courses")] },
    en: { name: "Monthly newsletter", description: "Featured course, tip of the month and events.", subject: "What's new at DevOpsAkademy this month", preheader: "Courses, tips and events you shouldn't miss.", social: "📰 The DevOpsAkademy monthly newsletter is out!",
      blocks: [h("This month's news"), p("Hello {{first_name}},\n\nHere is what to remember this month on the platform."), hr(), h("Featured"), course(), hr(), h("Our tip of the month"), p("Write a practical tip or a DevOps news item here."), btn("Browse all courses", "/courses")] },
  },
  {
    slug: "success_story", icon: "Trophy", category: "content", kind: "newsletter", audience: { roles: ["student"] }, banner_tone: "success",
    fr: { name: "Histoire de réussite", description: "Un témoignage d'apprenant pour inspirer et rassurer.", subject: "De la formation au premier poste : l'histoire de {{first_name}}…", preheader: "Un parcours qui peut être le vôtre.", social: "🏆 Ils ont réussi grâce à DevOpsAkademy : découvrez leur histoire.",
      blocks: [h("Un parcours qui inspire"), p("Bonjour {{first_name}},\n\nRacontez ici le parcours d'un apprenant : son point de départ, les cours suivis, et ce que la formation a changé pour lui (emploi, promotion, certification)."), p("« Ajoutez ici une citation de l'apprenant. »"), course(), btn("Commencer mon parcours", "/courses")] },
    en: { name: "Success story", description: "A learner testimonial to inspire and reassure.", subject: "From training to a first job: a learner's story…", preheader: "A journey that could be yours.", social: "🏆 They made it thanks to DevOpsAkademy: discover their story.",
      blocks: [h("A journey that inspires"), p("Hello {{first_name}},\n\nTell the story of a learner here: their starting point, the courses taken, and what the training changed for them (job, promotion, certification)."), p("“Add a quote from the learner here.”"), course(), btn("Start my journey", "/courses")] },
  },
  {
    slug: "maintenance", icon: "Wrench", category: "content", kind: "announcement", audience: { roles: ["student", "instructor"] }, banner_tone: "info",
    fr: { name: "Annonce : maintenance ou nouveauté", description: "Informez d'une maintenance, d'une nouvelle fonctionnalité ou d'un changement.", subject: "Information importante de DevOpsAkademy", preheader: "Ce qui change pour vous.", social: "",
      blocks: [h("Information importante"), p("Bonjour {{first_name}},\n\nDécrivez ici le changement : ce qui est concerné, la date et l'heure, et ce que l'utilisateur doit faire (ou ne rien faire)."), btn("En savoir plus", "/faq")] },
    en: { name: "Announcement: maintenance or news", description: "Inform about maintenance, a new feature or a change.", subject: "Important information from DevOpsAkademy", preheader: "What changes for you.", social: "",
      blocks: [h("Important information"), p("Hello {{first_name}},\n\nDescribe the change here: what is affected, the date and time, and what the user needs to do (or nothing)."), btn("Learn more", "/faq")] },
  },
  // ───────────── Fidélisation ─────────────
  {
    slug: "reengage", icon: "RotateCcw", category: "retention", kind: "newsletter", audience: { roles: ["student"], inactive_days: 30 }, banner_tone: "info",
    fr: { name: "Réactivation — vous nous manquez", description: "Relancez les inscrits sans connexion depuis 30 jours.", subject: "{{first_name}}, vos cours vous attendent", preheader: "Reprenez là où vous vous êtes arrêté.", social: "",
      blocks: [h("Vous nous manquez !"), p("Bonjour {{first_name}},\n\nCela fait un moment que nous ne vous avons pas vu. Votre progression est sauvegardée : reprenez en quelques minutes."), btn("Reprendre mes cours", "/my-courses")] },
    en: { name: "Re-engagement — we miss you", description: "Win back subscribers who haven't logged in for 30 days.", subject: "{{first_name}}, your courses are waiting", preheader: "Pick up where you left off.", social: "",
      blocks: [h("We miss you!"), p("Hello {{first_name}},\n\nIt has been a while. Your progress is saved — pick up again in a few minutes."), btn("Resume my courses", "/my-courses")] },
  },
  {
    slug: "finish_course", icon: "Flag", category: "retention", kind: "newsletter", audience: { roles: ["student"] }, banner_tone: "info",
    fr: { name: "Terminez votre cours", description: "Encouragez à finir un cours commencé pour obtenir le certificat.", subject: "{{first_name}}, plus que quelques leçons avant votre certificat", preheader: "Vous y êtes presque.", social: "",
      blocks: [h("Vous y êtes presque !"), p("Bonjour {{first_name}},\n\nVous avez bien avancé. Terminez votre cours pour obtenir votre certificat et le valoriser sur votre CV et LinkedIn."), btn("Reprendre là où je me suis arrêté", "/my-courses")] },
    en: { name: "Finish your course", description: "Encourage finishing a started course to earn the certificate.", subject: "{{first_name}}, only a few lessons left before your certificate", preheader: "You're almost there.", social: "",
      blocks: [h("You're almost there!"), p("Hello {{first_name}},\n\nYou've made great progress. Finish your course to earn your certificate and showcase it on your CV and LinkedIn."), btn("Pick up where I left off", "/my-courses")] },
  },
  {
    slug: "subscription_offer", icon: "CreditCard", category: "retention", kind: "offer", audience: { roles: ["student"], subscription: "none" }, banner_tone: "promo",
    fr: { name: "Passez à l'abonnement", description: "Présentez l'abonnement pour accéder à plusieurs cours.", subject: "Un seul abonnement, tous les cours", preheader: "Apprenez sans limite.", social: "",
      blocks: [h("Apprenez sans limite"), p("Bonjour {{first_name}},\n\nAvec l'abonnement, accédez aux cours inclus sans payer chacun séparément. Idéal pour progresser plus vite."), btn("Voir les abonnements", "/pricing")] },
    en: { name: "Switch to a subscription", description: "Present the subscription for access to several courses.", subject: "One subscription, all the courses", preheader: "Learn without limits.", social: "",
      blocks: [h("Learn without limits"), p("Hello {{first_name}},\n\nWith the subscription, access the included courses without paying for each one. Ideal to progress faster."), btn("See subscriptions", "/pricing")] },
  },
  // ───────────── Saisonniers ─────────────
  {
    slug: "back_to_school", icon: "GraduationCap", category: "seasonal", kind: "offer", audience: { roles: ["student"] }, promo: { type: "percent", percent: 30, days: 7 }, banner_tone: "promo",
    fr: { name: "Rentrée — -30 % pendant une semaine", description: "Offre de rentrée pour relancer l'apprentissage.", subject: "🎒 Rentrée : -30 % sur une sélection de cours", preheader: "Une semaine pour bien démarrer.", social: "🎒 C'est la rentrée sur DevOpsAkademy : -30 % pendant une semaine !",
      blocks: [h("C'est la rentrée 🎒"), p("Bonjour {{first_name}},\n\nNouvelle saison, nouvelles compétences. Pendant une semaine, profitez de -30 % sur ce cours pour bien démarrer."), course(), btn("Je me lance", "/courses")] },
    en: { name: "Back to school — -30% for a week", description: "Back-to-school offer to restart learning.", subject: "🎒 Back to school: -30% on selected courses", preheader: "One week to get off to a good start.", social: "🎒 Back to school on DevOpsAkademy: -30% for a week!",
      blocks: [h("Back to school 🎒"), p("Hello {{first_name}},\n\nNew season, new skills. For one week, enjoy -30% on this course to get off to a good start."), course(), btn("Let's go", "/courses")] },
  },
  {
    slug: "black_friday", icon: "ShoppingBag", category: "seasonal", kind: "offer", audience: { roles: ["student"] }, promo: { type: "percent", percent: 40, days: 4 }, banner_tone: "urgent",
    fr: { name: "Black Friday — -40 %", description: "Grosse offre de 4 jours, avec décompte d'urgence.", subject: "🖤 Black Friday : -40 % pendant 4 jours", preheader: "Les meilleurs prix de l'année.", social: "🖤 Black Friday DevOpsAkademy : -40 % pendant 4 jours seulement !",
      blocks: [h("🖤 Black Friday"), p("Bonjour {{first_name}},\n\nLes meilleurs prix de l'année, pendant 4 jours seulement : -40 % sur ce cours."), course(), btn("Profiter du Black Friday", "/courses"), p("Le prix normal revient automatiquement à la fin de l'offre.")] },
    en: { name: "Black Friday — -40%", description: "A big 4-day offer, with an urgency countdown.", subject: "🖤 Black Friday: -40% for 4 days", preheader: "The best prices of the year.", social: "🖤 DevOpsAkademy Black Friday: -40% for 4 days only!",
      blocks: [h("🖤 Black Friday"), p("Hello {{first_name}},\n\nThe best prices of the year, for 4 days only: -40% on this course."), course(), btn("Get the Black Friday deal", "/courses"), p("The regular price returns automatically when the offer ends.")] },
  },
  {
    slug: "year_end_gift", icon: "Gift", category: "seasonal", kind: "offer", audience: { roles: ["student"] }, promo: { type: "free", days: 5 }, banner_tone: "success",
    fr: { name: "Fêtes de fin d'année — cours offert", description: "Un cadeau de fin d'année : un cours gratuit pendant les fêtes.", subject: "🎄 Notre cadeau de fin d'année : un cours offert", preheader: "Bonnes fêtes de la part de toute l'équipe.", social: "🎄 Notre cadeau de fin d'année : un cours gratuit sur DevOpsAkademy !",
      blocks: [h("🎄 Joyeuses fêtes !"), p("Bonjour {{first_name}},\n\nPour terminer l'année en beauté, nous vous offrons ce cours pendant les fêtes. Profitez-en pour apprendre à votre rythme."), course(), btn("Recevoir mon cadeau", "/courses")] },
    en: { name: "Year-end holidays — free course", description: "A year-end gift: a free course during the holidays.", subject: "🎄 Our year-end gift: a free course", preheader: "Happy holidays from the whole team.", social: "🎄 Our year-end gift: a free course on DevOpsAkademy!",
      blocks: [h("🎄 Happy holidays!"), p("Hello {{first_name}},\n\nTo end the year on a high note, we are giving you this course during the holidays. Take the opportunity to learn at your own pace."), course(), btn("Get my gift", "/courses")] },
  },
  {
    slug: "new_year", icon: "Target", category: "seasonal", kind: "newsletter", audience: { roles: ["student"] }, banner_tone: "info",
    fr: { name: "Nouvelle année — vos objectifs", description: "Bonnes résolutions : un plan d'apprentissage pour l'année.", subject: "🎯 {{first_name}}, quel est votre objectif pour cette année ?", preheader: "Un plan simple pour progresser.", social: "🎯 Nouvelle année, nouvelles compétences : lancez-vous sur DevOpsAkademy !",
      blocks: [h("Bonne année 🎯"), p("Bonjour {{first_name}},\n\nCette année, visez une compétence concrète : Docker, Kubernetes, CI/CD, cloud… Choisissez un cours, fixez-vous 3 séances par semaine, et avancez pas à pas."), course(), btn("Choisir mon objectif", "/courses")] },
    en: { name: "New year — your goals", description: "Resolutions: a learning plan for the year.", subject: "🎯 {{first_name}}, what is your goal this year?", preheader: "A simple plan to progress.", social: "🎯 New year, new skills: get started on DevOpsAkademy!",
      blocks: [h("Happy new year 🎯"), p("Hello {{first_name}},\n\nThis year, aim for a concrete skill: Docker, Kubernetes, CI/CD, cloud… Pick a course, set yourself 3 sessions a week, and move forward step by step."), course(), btn("Choose my goal", "/courses")] },
  },
  // ───────────── Croissance ─────────────
  {
    slug: "become_instructor", icon: "Presentation", category: "growth", kind: "announcement", audience: { roles: ["student"] }, banner_tone: "promo",
    fr: { name: "Devenez instructeur", description: "Invitez vos meilleurs apprenants à partager leur expertise.", subject: "{{first_name}}, et si vous enseigniez sur DevOpsAkademy ?", preheader: "Partagez votre expertise et gagnez des revenus.", social: "🎓 Experts DevOps, enseignez sur DevOpsAkademy et générez des revenus !",
      blocks: [h("Partagez votre expertise"), p("Bonjour {{first_name}},\n\nVous maîtrisez un sujet DevOps ou cloud ? Devenez instructeur : créez vos cours, touchez des milliers d'apprenants et percevez une part des ventes."), btn("Je candidate", "/become-instructor")] },
    en: { name: "Become an instructor", description: "Invite your best learners to share their expertise.", subject: "{{first_name}}, what if you taught on DevOpsAkademy?", preheader: "Share your expertise and earn revenue.", social: "🎓 DevOps experts, teach on DevOpsAkademy and earn revenue!",
      blocks: [h("Share your expertise"), p("Hello {{first_name}},\n\nDo you master a DevOps or cloud topic? Become an instructor: create your courses, reach thousands of learners and earn a share of sales."), btn("Apply now", "/become-instructor")] },
  },
  {
    slug: "referral", icon: "Users", category: "growth", kind: "newsletter", audience: { roles: ["student"] }, banner_tone: "success",
    fr: { name: "Parrainez un ami", description: "Encouragez le bouche-à-oreille.", subject: "{{first_name}}, invitez un ami à apprendre avec vous", preheader: "Apprendre à deux, c'est mieux.", social: "",
      blocks: [h("Apprenez à deux"), p("Bonjour {{first_name}},\n\nVous aimez DevOpsAkademy ? Invitez un collègue ou un ami : il bénéficiera de notre accompagnement, et vous progresserez ensemble."), btn("Inviter un ami", "/profile")] },
    en: { name: "Refer a friend", description: "Encourage word of mouth.", subject: "{{first_name}}, invite a friend to learn with you", preheader: "Learning together is better.", social: "",
      blocks: [h("Learn together"), p("Hello {{first_name}},\n\nEnjoying DevOpsAkademy? Invite a colleague or a friend: they will benefit from our support, and you will progress together."), btn("Invite a friend", "/profile")] },
  },
  {
    slug: "feedback_survey", icon: "ClipboardList", category: "growth", kind: "newsletter", audience: { roles: ["student"] }, banner_tone: "info",
    fr: { name: "Enquête de satisfaction", description: "Demandez l'avis de vos apprenants.", subject: "{{first_name}}, votre avis compte (2 minutes)", preheader: "Aidez-nous à améliorer la plateforme.", social: "",
      blocks: [h("Votre avis nous intéresse"), p("Bonjour {{first_name}},\n\nQu'est-ce qui vous plaît sur la plateforme ? Qu'aimeriez-vous voir en plus ? Répondez en 2 minutes, nous lisons chaque retour."), btn("Donner mon avis", "/contact")] },
    en: { name: "Satisfaction survey", description: "Ask your learners for their opinion.", subject: "{{first_name}}, your opinion matters (2 minutes)", preheader: "Help us improve the platform.", social: "",
      blocks: [h("We'd love your feedback"), p("Hello {{first_name}},\n\nWhat do you like on the platform? What would you like to see added? Answer in 2 minutes — we read every response."), btn("Give my feedback", "/contact")] },
  },
  {
    slug: "blank", icon: "FileText", category: "content", kind: "newsletter", audience: { roles: ["student", "instructor"] }, banner_tone: "info",
    fr: { name: "Campagne vierge", description: "Partez d'une page blanche.", subject: "", preheader: "", social: "", blocks: [h(""), p("Bonjour {{first_name}},")] },
    en: { name: "Blank campaign", description: "Start from a blank page.", subject: "", preheader: "", social: "", blocks: [h(""), p("Hello {{first_name}},")] },
  },
];

// ───────────── Bannières prêtes à l'emploi ─────────────
export const BANNER_PRESETS = [
  { slug: "b_free_course", fr: { name: "Cours gratuit", title: "🎁 Un cours offert pendant 72 h", body: "Profitez-en avant la fin de l'offre.", cta: "J'en profite" }, en: { name: "Free course", title: "🎁 A free course for 72 hours", body: "Grab it before the offer ends.", cta: "Get it" }, placement: "top_bar", tone: "success", url: "/courses" },
  { slug: "b_half_price", fr: { name: "Moitié prix", title: "🔥 -50 % sur une sélection de cours", body: "Offre limitée dans le temps.", cta: "Voir les cours" }, en: { name: "Half price", title: "🔥 -50% on selected courses", body: "Limited-time offer.", cta: "See courses" }, placement: "top_bar", tone: "promo", url: "/courses" },
  { slug: "b_flash", fr: { name: "Vente flash", title: "⚡ Vente flash : 24 h seulement", body: "-30 % jusqu'à demain.", cta: "J'en profite" }, en: { name: "Flash sale", title: "⚡ Flash sale: 24 hours only", body: "-30% until tomorrow.", cta: "Get it" }, placement: "top_bar", tone: "urgent", url: "/courses" },
  { slug: "b_webinar", fr: { name: "Webinaire", title: "📅 Webinaire en direct", body: "Inscription gratuite, places limitées.", cta: "Je m'inscris" }, en: { name: "Webinar", title: "📅 Live webinar", body: "Free registration, limited seats.", cta: "Register" }, placement: "top_bar", tone: "info", url: "/bootcamps" },
  { slug: "b_new_course", fr: { name: "Nouveau cours", title: "🆕 Un nouveau cours est disponible", body: "Découvrez-le dès maintenant.", cta: "Découvrir" }, en: { name: "New course", title: "🆕 A new course is available", body: "Discover it now.", cta: "Discover" }, placement: "popup", tone: "promo", url: "/courses" },
  { slug: "b_welcome", fr: { name: "Bienvenue (-20 %)", title: "👋 Bienvenue ! -20 % sur votre premier cours", body: "Code BIENVENUE20 au paiement.", cta: "Choisir un cours" }, en: { name: "Welcome (-20%)", title: "👋 Welcome! -20% on your first course", body: "Code BIENVENUE20 at checkout.", cta: "Pick a course" }, placement: "popup", tone: "promo", url: "/courses" },
  { slug: "b_black_friday", fr: { name: "Black Friday", title: "🖤 Black Friday : -40 % pendant 4 jours", body: "Les meilleurs prix de l'année.", cta: "Profiter" }, en: { name: "Black Friday", title: "🖤 Black Friday: -40% for 4 days", body: "The best prices of the year.", cta: "Get the deal" }, placement: "top_bar", tone: "urgent", url: "/courses" },
  { slug: "b_instructor", fr: { name: "Devenez instructeur", title: "🎓 Enseignez sur DevOpsAkademy", body: "Partagez votre expertise et gagnez des revenus.", cta: "Je candidate" }, en: { name: "Become an instructor", title: "🎓 Teach on DevOpsAkademy", body: "Share your expertise and earn revenue.", cta: "Apply" }, placement: "inline_home", tone: "info", url: "/become-instructor" },
];

// ───────────── Publications réseaux sociaux prêtes à l'emploi ─────────────
export const SOCIAL_PRESETS = [
  { slug: "s_free_course", fr: { name: "Cours gratuit", text: "🎁 Cours gratuit pendant 72 h sur DevOpsAkademy !\nInscrivez-vous avant la fin de l'offre et apprenez à votre rythme.\n\n#DevOps #Formation #Gratuit" }, en: { name: "Free course", text: "🎁 Free course for 72 hours on DevOpsAkademy!\nEnrol before the offer ends and learn at your own pace.\n\n#DevOps #Training #Free" } },
  { slug: "s_half_price", fr: { name: "Moitié prix", text: "🔥 -50 % sur nos cours DevOps pendant 72 h seulement.\nDocker, Kubernetes, CI/CD, cloud… choisissez votre parcours.\n\n#DevOps #Promo" }, en: { name: "Half price", text: "🔥 -50% on our DevOps courses for 72 hours only.\nDocker, Kubernetes, CI/CD, cloud… pick your path.\n\n#DevOps #Sale" } },
  { slug: "s_webinar", fr: { name: "Webinaire", text: "📅 Webinaire en direct — inscription gratuite !\nPosez vos questions à nos experts et repartez avec des conseils concrets.\n\n#Webinaire #DevOps #Cloud" }, en: { name: "Webinar", text: "📅 Live webinar — free registration!\nAsk our experts your questions and leave with practical advice.\n\n#Webinar #DevOps #Cloud" } },
  { slug: "s_new_course", fr: { name: "Nouveau cours", text: "🆕 Nouveau cours sur DevOpsAkademy !\nDes projets concrets, des exercices corrigés et un certificat à la clé.\n\n#DevOps #NouveauCours" }, en: { name: "New course", text: "🆕 New course on DevOpsAkademy!\nHands-on projects, solved exercises and a certificate.\n\n#DevOps #NewCourse" } },
  { slug: "s_tip", fr: { name: "Astuce DevOps", text: "💡 Astuce DevOps du jour :\n[Écrivez ici une astuce courte et utile]\n\nPlus d'astuces et de cours sur DevOpsAkademy.\n\n#DevOps #Astuce" }, en: { name: "DevOps tip", text: "💡 DevOps tip of the day:\n[Write a short, useful tip here]\n\nMore tips and courses on DevOpsAkademy.\n\n#DevOps #Tip" } },
  { slug: "s_instructor", fr: { name: "Appel aux experts", text: "🎓 Vous maîtrisez le DevOps ou le cloud ?\nEnseignez sur DevOpsAkademy, touchez des milliers d'apprenants et gagnez des revenus.\n\n#Formateur #DevOps" }, en: { name: "Call for experts", text: "🎓 Do you master DevOps or cloud?\nTeach on DevOpsAkademy, reach thousands of learners and earn revenue.\n\n#Instructor #DevOps" } },
  { slug: "s_success", fr: { name: "Témoignage", text: "🏆 « [Citation de l'apprenant] »\n— [Prénom], apprenant DevOpsAkademy.\n\nVotre tour ?\n\n#Réussite #DevOps" }, en: { name: "Testimonial", text: "🏆 “[Learner quote]”\n— [First name], DevOpsAkademy learner.\n\nYour turn?\n\n#Success #DevOps" } },
];

// ───────────── Automatisations préenregistrées (désactivées par défaut) ─────────────
export interface AutoPreset {
  slug: string; name_fr: string; name_en: string; trigger: "signup" | "no_enrollment" | "inactive" | "course_stalled" | "course_completed";
  delay_days: number; pref: "newsletter" | "promotions" | "events"; blocks_fr: B[]; blocks_en: B[];
  subject_fr: string; subject_en: string; preheader_fr: string; preheader_en: string;
}
export const AUTOMATION_PRESETS: AutoPreset[] = [
  { slug: "welcome_1", name_fr: "Bienvenue (jour 0)", name_en: "Welcome (day 0)", trigger: "signup", delay_days: 0, pref: "newsletter",
    subject_fr: "Bienvenue sur DevOpsAkademy, {{first_name}} 🎉", subject_en: "Welcome to DevOpsAkademy, {{first_name}} 🎉", preheader_fr: "Voici comment bien démarrer.", preheader_en: "Here is how to get started.",
    blocks_fr: [h("Bienvenue !"), p("Bonjour {{first_name}},\n\nMerci d'avoir rejoint DevOpsAkademy. Voici comment bien démarrer : parcourez le catalogue, choisissez un cours adapté à votre niveau, et avancez à votre rythme."), btn("Explorer les cours", "/courses")],
    blocks_en: [h("Welcome!"), p("Hello {{first_name}},\n\nThanks for joining DevOpsAkademy. Here is how to get started: browse the catalogue, pick a course that fits your level, and move at your own pace."), btn("Explore courses", "/courses")] },
  { slug: "welcome_2", name_fr: "Bienvenue (jour 2) — nos cours gratuits", name_en: "Welcome (day 2) — our free courses", trigger: "signup", delay_days: 2, pref: "newsletter",
    subject_fr: "{{first_name}}, commencez avec un cours gratuit", subject_en: "{{first_name}}, start with a free course", preheader_fr: "Zéro risque pour démarrer.", preheader_en: "Zero risk to start.",
    blocks_fr: [h("Commencez sans payer"), p("Bonjour {{first_name}},\n\nPour vous lancer sans risque, découvrez nos cours gratuits : une excellente façon de tester la plateforme et de gagner vos premières compétences."), btn("Voir les cours gratuits", "/courses"), p("Une question ? Répondez simplement à cet email.")],
    blocks_en: [h("Start without paying"), p("Hello {{first_name}},\n\nTo get started risk-free, discover our free courses: a great way to try the platform and earn your first skills."), btn("See free courses", "/courses"), p("Any question? Just reply to this email.")] },
  { slug: "welcome_3", name_fr: "Bienvenue (jour 5) — votre parcours", name_en: "Welcome (day 5) — your path", trigger: "signup", delay_days: 5, pref: "newsletter",
    subject_fr: "{{first_name}}, quel est votre objectif ?", subject_en: "{{first_name}}, what is your goal?", preheader_fr: "Construisons votre parcours.", preheader_en: "Let's build your path.",
    blocks_fr: [h("Construisons votre parcours"), p("Bonjour {{first_name}},\n\nDocker, Kubernetes, CI/CD, cloud… Chaque objectif a son parcours. Choisissez le vôtre et fixez-vous 3 séances par semaine : les résultats suivent vite."), btn("Choisir mon parcours", "/courses")],
    blocks_en: [h("Let's build your path"), p("Hello {{first_name}},\n\nDocker, Kubernetes, CI/CD, cloud… every goal has its path. Pick yours and set 3 sessions a week: results come fast."), btn("Pick my path", "/courses")] },
  { slug: "no_enrollment", name_fr: "Aucune inscription après 7 jours", name_en: "No enrolment after 7 days", trigger: "no_enrollment", delay_days: 7, pref: "promotions",
    subject_fr: "{{first_name}}, on vous aide à choisir votre premier cours ?", subject_en: "{{first_name}}, shall we help you pick your first course?", preheader_fr: "Un conseil pour bien commencer.", preheader_en: "A tip to start well.",
    blocks_fr: [h("Par où commencer ?"), p("Bonjour {{first_name}},\n\nVous ne savez pas quel cours choisir ? Commencez par les fondamentaux : ils vous donnent les bases pour tout le reste. Et si vous hésitez, écrivez-nous."), btn("Voir les cours", "/courses"), btn("Nous contacter", "/contact")],
    blocks_en: [h("Where to start?"), p("Hello {{first_name}},\n\nNot sure which course to pick? Start with the fundamentals: they give you the basics for everything else. And if you hesitate, write to us."), btn("See courses", "/courses"), btn("Contact us", "/contact")] },
  { slug: "inactive_30", name_fr: "Inactif depuis 30 jours", name_en: "Inactive for 30 days", trigger: "inactive", delay_days: 30, pref: "newsletter",
    subject_fr: "{{first_name}}, vos cours vous attendent", subject_en: "{{first_name}}, your courses are waiting", preheader_fr: "Reprenez là où vous vous êtes arrêté.", preheader_en: "Pick up where you left off.",
    blocks_fr: [h("Vous nous manquez !"), p("Bonjour {{first_name}},\n\nCela fait un moment que nous ne vous avons pas vu. Votre progression est sauvegardée : reprenez en quelques minutes."), btn("Reprendre mes cours", "/my-courses")],
    blocks_en: [h("We miss you!"), p("Hello {{first_name}},\n\nIt has been a while. Your progress is saved — pick up again in a few minutes."), btn("Resume my courses", "/my-courses")] },
  { slug: "course_stalled", name_fr: "Cours commencé mais en pause (7 jours)", name_en: "Started course on hold (7 days)", trigger: "course_stalled", delay_days: 7, pref: "newsletter",
    subject_fr: "{{first_name}}, reprenez « {{course_title}} »", subject_en: "{{first_name}}, resume “{{course_title}}”", preheader_fr: "Quelques minutes suffisent pour reprendre.", preheader_en: "A few minutes is all it takes.",
    blocks_fr: [h("Vous avez commencé « {{course_title}} »"), p("Bonjour {{first_name}},\n\nVous avez déjà bien avancé. Reprenez où vous vous êtes arrêté : 15 minutes aujourd'hui valent mieux que 2 heures un jour que vous n'aurez jamais."), btn("Reprendre mon cours", "/my-courses")],
    blocks_en: [h("You started “{{course_title}}”"), p("Hello {{first_name}},\n\nYou've already made good progress. Resume where you left off: 15 minutes today beats 2 hours on a day that never comes."), btn("Resume my course", "/my-courses")] },
  { slug: "course_completed", name_fr: "Cours terminé — et maintenant ?", name_en: "Course completed — what's next?", trigger: "course_completed", delay_days: 1, pref: "newsletter",
    subject_fr: "Bravo {{first_name}} ! Quelle suite pour « {{course_title}} » ?", subject_en: "Congrats {{first_name}}! What's next after “{{course_title}}”?", preheader_fr: "Continuez sur votre lancée.", preheader_en: "Keep the momentum going.",
    blocks_fr: [h("Félicitations 🎉"), p("Bonjour {{first_name}},\n\nVous avez terminé « {{course_title}} » : bravo ! Pensez à partager votre certificat sur LinkedIn, et continuez sur votre lancée avec un cours complémentaire."), btn("Choisir mon prochain cours", "/courses")],
    blocks_en: [h("Congratulations 🎉"), p("Hello {{first_name}},\n\nYou completed “{{course_title}}”: well done! Remember to share your certificate on LinkedIn, and keep going with a complementary course."), btn("Pick my next course", "/courses")] },
];

// ══════════════════════════════════════════════════════
// SEMIS EN BASE (une seule fois par modèle : les modifications de l'admin ne sont jamais écrasées)
// ══════════════════════════════════════════════════════
export const presetContent = (t: Tpl) => ({
  fr: { subject: t.fr.subject, preheader: t.fr.preheader, social: t.fr.social, blocks: t.fr.blocks },
  en: { subject: t.en.subject, preheader: t.en.preheader, social: t.en.social, blocks: t.en.blocks },
  audience: t.audience || {}, promo: t.promo || null, coupon: t.coupon || null, banner_tone: t.banner_tone || "info",
});

export async function seedMarketingPresets(): Promise<void> {
  for (const [i, t] of TEMPLATE_PRESETS.entries()) {
    await query(
      `INSERT IGNORE INTO marketing_templates (slug, type, name_fr, name_en, description_fr, description_en, icon, category, kind, content, is_builtin, sort_order)
       VALUES (?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [t.slug, t.fr.name, t.en.name, t.fr.description, t.en.description, t.icon, t.category, t.kind, JSON.stringify(presetContent(t)), i]);
  }
  for (const [i, b] of BANNER_PRESETS.entries()) {
    await query(
      `INSERT IGNORE INTO marketing_templates (slug, type, name_fr, name_en, description_fr, description_en, icon, category, kind, content, is_builtin, sort_order)
       VALUES (?, 'banner', ?, ?, NULL, NULL, 'Megaphone', 'banner', 'announcement', ?, 1, ?)`,
      [b.slug, b.fr.name, b.en.name, JSON.stringify({ placement: b.placement, tone: b.tone, url: b.url, fr: b.fr, en: b.en }), i]);
  }
  for (const [i, s] of SOCIAL_PRESETS.entries()) {
    await query(
      `INSERT IGNORE INTO marketing_templates (slug, type, name_fr, name_en, description_fr, description_en, icon, category, kind, content, is_builtin, sort_order)
       VALUES (?, 'social', ?, ?, NULL, NULL, 'Share2', 'social', 'announcement', ?, 1, ?)`,
      [s.slug, s.fr.name, s.en.name, JSON.stringify({ fr: { text: s.fr.text }, en: { text: s.en.text } }), i]);
  }
  for (const a of AUTOMATION_PRESETS) {
    await query(
      `INSERT IGNORE INTO marketing_automations (slug, name_fr, name_en, trigger_type, delay_days, pref, subject_fr, subject_en, preheader_fr, preheader_en, blocks_fr, blocks_en, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [a.slug, a.name_fr, a.name_en, a.trigger, a.delay_days, a.pref, a.subject_fr, a.subject_en, a.preheader_fr, a.preheader_en, JSON.stringify(a.blocks_fr), JSON.stringify(a.blocks_en)]);
  }
}

/** Contenu d'origine d'un modèle d'usine (pour la restauration). */
export function originalPreset(slug: string): { name_fr: string; name_en: string; description_fr: string | null; description_en: string | null; content: any } | null {
  const t = TEMPLATE_PRESETS.find((x) => x.slug === slug);
  if (t) return { name_fr: t.fr.name, name_en: t.en.name, description_fr: t.fr.description, description_en: t.en.description, content: presetContent(t) };
  const b = BANNER_PRESETS.find((x) => x.slug === slug);
  if (b) return { name_fr: b.fr.name, name_en: b.en.name, description_fr: null, description_en: null, content: { placement: b.placement, tone: b.tone, url: b.url, fr: b.fr, en: b.en } };
  const s = SOCIAL_PRESETS.find((x) => x.slug === slug);
  if (s) return { name_fr: s.fr.name, name_en: s.en.name, description_fr: null, description_en: null, content: { fr: { text: s.fr.text }, en: { text: s.en.text } } };
  return null;
}
