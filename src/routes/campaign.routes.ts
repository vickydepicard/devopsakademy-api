// Campagnes / événements du site + thèmes de couleurs
import express from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import {
  getActiveCampaigns,
  listCampaigns, getCampaign, createCampaign, updateCampaign, setCampaignActive, deleteCampaign,
  createSlide, updateSlide, setSlideActive, deleteSlide, reorderSlides,
  listThemes, createTheme, updateTheme, deleteTheme,
} from "../controllers/campaignController";

// ── Public : GET /api/campaigns/active ──
export const campaignPublicRouter = express.Router();
campaignPublicRouter.get("/active", getActiveCampaigns);

// ── Admin : /api/admin/campaigns/… ──
export const campaignAdminRouter = express.Router();
campaignAdminRouter.use(authenticate, authorizeRoles(["admin", "superadmin"]));
campaignAdminRouter.get   ("/",                       listCampaigns);
campaignAdminRouter.post  ("/",                       createCampaign);
// slides (avant "/:id" pour que "slides" ne soit pas pris pour un id)
campaignAdminRouter.put   ("/slides/:slideId",        updateSlide);
campaignAdminRouter.patch ("/slides/:slideId/active", setSlideActive);
campaignAdminRouter.delete("/slides/:slideId",        deleteSlide);
campaignAdminRouter.get   ("/:id",                    getCampaign);
campaignAdminRouter.put   ("/:id",                    updateCampaign);
campaignAdminRouter.patch ("/:id/active",             setCampaignActive);
campaignAdminRouter.delete("/:id",                    deleteCampaign);
campaignAdminRouter.post  ("/:id/slides",             createSlide);
campaignAdminRouter.patch ("/:id/slides/reorder",     reorderSlides);

// ── Admin : /api/admin/themes/… ──
export const themeAdminRouter = express.Router();
themeAdminRouter.use(authenticate, authorizeRoles(["admin", "superadmin"]));
themeAdminRouter.get   ("/",    listThemes);
themeAdminRouter.post  ("/",    createTheme);
themeAdminRouter.put   ("/:id", updateTheme);
themeAdminRouter.delete("/:id", deleteTheme);
