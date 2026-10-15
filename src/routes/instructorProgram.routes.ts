// src/routes/instructorProgram.routes.ts — monté sur /api/instructor-program
// Programme instructeurs : intégration, contrat, versements, paliers, messagerie, annonces,
// collaborations, performance, journal d'audit.
import { Router } from "express";
import { authenticate, authorizeRoles } from "../middleware/auth";
import { requireInstructorOrAdmin } from "../middleware/permissions";
import * as ob from "../controllers/programOnboardingController";
import * as fin from "../controllers/programFinanceController";
import * as com from "../controllers/programCommsController";

const router = Router();
const adminOnly = authorizeRoles(["admin", "superadmin"]);
router.use(authenticate);

// ── Instructeur ──
const instr = requireInstructorOrAdmin;
router.get("/onboarding/me", instr, ob.getMyOnboarding);
router.get("/agreement", instr, ob.getMyAgreement);
router.post("/agreement/sign", instr, ob.signAgreement);
router.get("/payout-profile", instr, fin.getMyPayoutProfile);
router.put("/payout-profile", instr, fin.saveMyPayoutProfile);
router.get("/statement", instr, fin.getMyStatement);
router.get("/tier/me", instr, fin.getMyTier);
router.get("/messages", instr, com.getMyMessages);
router.post("/messages", instr, com.sendMyMessage);
router.get("/announcements", instr, com.getMyAnnouncements);
router.post("/announcements/:id/read", instr, com.markAnnouncementRead);
router.get("/inbox/summary", instr, com.getInboxSummary);
router.get("/collab/courses", instr, com.collabSearchCourses);
router.get("/collab/requests", instr, com.collabMyRequests);
router.post("/collab/requests", instr, com.collabCreateRequest);
router.delete("/collab/requests/:id", instr, com.collabWithdraw);
router.get("/courses/:id/review-history", instr, com.getCourseReviewHistory);

// ── Admin ──
router.get("/admin/onboarding", adminOnly, ob.adminOnboardingOverview);
router.get("/admin/instructors/:id/onboarding", adminOnly, ob.adminInstructorOnboarding);
router.post("/admin/instructors/:id/onboarding/remind", adminOnly, ob.remindInstructor);

router.get("/admin/agreements", adminOnly, ob.adminListAgreements);
router.post("/admin/agreements", adminOnly, ob.adminPublishAgreement);
router.get("/admin/agreements/:id", adminOnly, ob.adminGetAgreement);

router.get("/admin/instructors/:id/payout-profile", adminOnly, fin.adminGetPayoutProfile);
router.get("/admin/instructors/:id/statement", adminOnly, fin.adminStatement);
router.get("/admin/payouts/summary", adminOnly, fin.adminPayoutSummary);
router.post("/admin/payouts/batch", adminOnly, fin.adminPayoutBatch);

router.get("/admin/tiers", adminOnly, fin.adminListTiers);
router.post("/admin/tiers", adminOnly, fin.adminCreateTier);
router.patch("/admin/tiers/:id", adminOnly, fin.adminUpdateTier);
router.delete("/admin/tiers/:id", adminOnly, fin.adminDeleteTier);
router.get("/admin/instructors/:id/tier", adminOnly, fin.adminGetInstructorTier);
router.put("/admin/instructors/:id/tier", adminOnly, fin.adminAssignTier);

router.get("/admin/messages", adminOnly, com.adminInbox);
router.get("/admin/instructors/:id/messages", adminOnly, com.adminGetThread);
router.post("/admin/instructors/:id/messages", adminOnly, com.adminSendMessage);
router.get("/admin/announcements", adminOnly, com.adminListAnnouncements);
router.post("/admin/announcements", adminOnly, com.adminCreateAnnouncement);

router.get("/admin/collab", adminOnly, com.adminCollabList);
router.post("/admin/collab/:id/decide", adminOnly, com.adminCollabDecide);

router.get("/admin/instructors/:id/performance", adminOnly, com.adminPerformance);
router.get("/admin/watchlist", adminOnly, com.adminWatchlist);
router.get("/admin/instructors/:id/audit", adminOnly, com.adminInstructorAudit);
router.get("/admin/journal", adminOnly, com.adminJournal);

export default router;
