// src/routes/marketing.routes.ts — monté sur /api/marketing
// Newsletter, offres, bannières, réseaux sociaux, promotions de prix.
import { Router } from "express";
import { authenticate, authorizeRoles, optionalAuthenticate } from "../middleware/auth";
import * as m from "../controllers/marketingController";
import * as x from "../controllers/marketingExtras";

const router = Router();

// ── Public (liens des emails, formulaire d'inscription, bannières du site) ──
router.get("/o/:token", m.trackOpen);                       // pixel d'ouverture (/o/<token>.gif)
router.get("/c/:token/:idx", m.trackClick);                 // redirection avec comptage de clic
router.get("/unsubscribe/:ptoken", m.unsubscribe);
router.post("/unsubscribe/:ptoken", m.unsubscribe);         // « List-Unsubscribe-Post » (un clic)
router.get("/preferences/:ptoken", m.getPreferences);
router.put("/preferences/:ptoken", m.savePreferences);
router.post("/subscribe", m.subscribePublic);
router.get("/confirm/:token", m.confirmSubscription);
router.get("/banners/active", optionalAuthenticate as any, m.activeBanners as any);
router.post("/banners/:id/impression", m.bannerEvent("impressions"));
router.post("/banners/:id/click", m.bannerEvent("clicks"));

// ── Public : offres (codes promo affichés sur les cours) ──
router.get("/offers", x.publicOffers);

// ── Étudiant connecté : validation d'un code promo avant paiement ──
router.post("/coupons/validate", authenticate, x.validateCoupon);

// ── Admin ──
const admin = [authenticate, authorizeRoles(["admin", "superadmin"])];
router.get("/admin/meta", ...admin, m.adminMeta);
router.get("/admin/pickers", ...admin, m.pickers);

router.get("/admin/campaigns", ...admin, m.listCampaigns);
router.post("/admin/campaigns", ...admin, m.saveCampaign);
router.get("/admin/campaigns/:id", ...admin, m.getCampaign);
router.put("/admin/campaigns/:id", ...admin, m.saveCampaign);
router.delete("/admin/campaigns/:id", ...admin, m.deleteCampaign);
router.post("/admin/campaigns/:id/duplicate", ...admin, m.duplicateCampaign);
router.post("/admin/campaigns/:id/schedule", ...admin, m.scheduleCampaign);
router.post("/admin/campaigns/:id/cancel", ...admin, m.cancelCampaign);
router.post("/admin/campaigns/:id/retry", ...admin, m.retryFailed);
router.post("/admin/campaigns/:id/test", ...admin, m.testCampaign);
router.get("/admin/campaigns/:id/recipients", ...admin, m.listRecipients);
router.post("/admin/preview", ...admin, m.previewCampaign);
router.post("/admin/audience/count", ...admin, m.audienceCount);

router.get("/admin/banners", ...admin, m.listBanners);
router.post("/admin/banners", ...admin, m.saveBanner);
router.put("/admin/banners/:id", ...admin, m.saveBanner);
router.delete("/admin/banners/:id", ...admin, m.deleteBanner);

router.get("/admin/social", ...admin, m.listSocial);
router.post("/admin/social", ...admin, m.createSocial);
router.delete("/admin/social/:id", ...admin, m.deleteSocial);

router.get("/admin/subscribers/summary", ...admin, m.subscribersSummary);
router.get("/admin/subscribers/export", ...admin, m.exportSubscribers);
router.get("/admin/subscribers", ...admin, m.listSubscribers);
router.patch("/admin/subscribers/user/:id", ...admin, m.setUserSubscription);
router.post("/admin/contacts", ...admin, m.addContact);

router.get("/admin/promotions", ...admin, m.listPromotions);
router.post("/admin/promotions", ...admin, m.createPromotion);
router.post("/admin/promotions/:id/cancel", ...admin, m.cancelPromotion);

// Modèles enregistrés (campagnes, bannières, réseaux sociaux)
router.get("/admin/templates", ...admin, x.listTemplates);
router.post("/admin/templates", ...admin, x.createTemplate);
router.put("/admin/templates/:id", ...admin, x.updateTemplate);
router.delete("/admin/templates/:id", ...admin, x.deleteTemplate);
router.post("/admin/templates/:id/reset", ...admin, x.resetTemplate);

// Automatisations
router.get("/admin/automations", ...admin, x.listAutomations);
router.post("/admin/automations", ...admin, x.saveAutomation);
router.put("/admin/automations/:id", ...admin, x.saveAutomation);
router.post("/admin/automations/:id/toggle", ...admin, x.toggleAutomation);
router.post("/admin/automations/:id/reset", ...admin, x.resetAutomation);
router.post("/admin/automations/:id/test", ...admin, x.testAutomation);
router.get("/admin/automations/:id/preview", ...admin, x.previewAutomation);
router.delete("/admin/automations/:id", ...admin, x.deleteAutomation);

// Codes promo
router.get("/admin/coupons", ...admin, x.listCoupons);
router.post("/admin/coupons", ...admin, x.createCoupon);
router.put("/admin/coupons/:id", ...admin, x.updateCoupon);
router.delete("/admin/coupons/:id", ...admin, x.deleteCoupon);

export default router;
