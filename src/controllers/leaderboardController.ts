// src/controllers/leaderboardController.ts
// Classement des apprenants (table leaderboard_points) : vue publique + administration.
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { query } from "../config/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { toPlain, parseId } from "../utils/serialize";
import { fail, serverError, logAudit } from "../utils/respond";
import { tr } from "../utils/lang";
import { publicBaseUrl } from "../utils/publicUrl";

type Req = AuthenticatedRequest;

const periodClause = (period: unknown): string => {
  if (period === "week") return "AND lp.earned_at >= (NOW() - INTERVAL 7 DAY)";
  if (period === "month") return "AND lp.earned_at >= DATE_FORMAT(NOW(), '%Y-%m-01')";
  return "";
};

const absAvatar = (req: Request, url: any): string | null => {
  if (!url) return null;
  const s = String(url);
  return s.startsWith("/uploads/") ? `${publicBaseUrl(req)}${s}` : s;
};

/** Authentification facultative : renseigne req.user si un JWT valide est fourni, sans jamais bloquer. */
export const optionalAuth = async (req: Req, _res: Response, next: NextFunction) => {
  try {
    const h = req.headers["authorization"];
    if (h && h.startsWith("Bearer ")) {
      const decoded: any = jwt.verify(h.split(" ")[1], process.env.JWT_SECRET as string);
      const [u]: any = await query("SELECT id, role, is_active FROM users WHERE id = ?", [decoded.id]);
      if (u && u.is_active) req.user = { id: Number(u.id), role: u.role };
    }
  } catch { /* jeton absent/invalide : consultation anonyme */ }
  next();
};

// GET /api/leaderboard?period=all|month|week&limit=50   (public, my_rank si connecté)
export const getPublicLeaderboard = async (req: Req, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 50, 1), 200);
    const me = req.user?.id ?? 0;
    const rows = toPlain<any[]>(await query(
      `SELECT t.* FROM (
         SELECT u.id AS user_id,
                COALESCE(NULLIF(up.leaderboard_pseudonym, ''),
                         TRIM(CONCAT(u.first_name, ' ', IF(u.last_name IS NULL OR u.last_name = '', '', CONCAT(LEFT(u.last_name, 1), '.'))))) AS display_name,
                up.avatar_url,
                SUM(lp.points) AS leaderboard_points,
                RANK() OVER (ORDER BY SUM(lp.points) DESC) AS \`rank\`
           FROM leaderboard_points lp
           JOIN users u ON u.id = lp.user_id AND u.is_active = 1 AND u.role NOT IN ('admin','superadmin')
           LEFT JOIN user_profiles up ON up.user_id = u.id
          WHERE (up.leaderboard_visible IS NULL OR up.leaderboard_visible = 1 OR u.id = ?) ${periodClause(req.query.period)}
          GROUP BY u.id, up.leaderboard_pseudonym, up.avatar_url
         HAVING SUM(lp.points) > 0
       ) t ORDER BY t.\`rank\` ASC, t.user_id ASC LIMIT 5000`,
      [me]
    ));
    const all = rows.map((r) => ({ ...r, leaderboard_points: Number(r.leaderboard_points), avatar_url: absAvatar(req, r.avatar_url) }));
    const mine = me ? all.find((r) => r.user_id === me) : undefined;
    return res.json({
      success: true,
      data: {
        leaderboard: all.slice(0, limit),
        my_rank: mine ? { rank: mine.rank, leaderboard_points: mine.leaderboard_points } : null,
        total: all.length,
        period: ["week", "month"].includes(String(req.query.period)) ? req.query.period : "all",
      },
    });
  } catch (error) {
    return serverError(req, res, "getPublicLeaderboard", error);
  }
};

// GET /api/admin/leaderboard?limit=100&search=   (apprenants actifs, y compris à 0 point)
export const getAdminLeaderboard = async (req: Req, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 100, 1), 1000);
    const search = String(req.query.search || "").trim();
    const params: any[] = [];
    let searchSql = "";
    if (search) {
      searchSql = "AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)";
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      params.push(like, like, like);
    }
    const rows = toPlain<any[]>(await query(
      `SELECT u.id AS user_id, u.email,
              TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS display_name,
              up.avatar_url,
              COALESCE(SUM(lp.points), 0) AS leaderboard_points,
              COUNT(lp.id) AS entries,
              RANK() OVER (ORDER BY COALESCE(SUM(lp.points), 0) DESC) AS \`rank\`
         FROM users u
         LEFT JOIN leaderboard_points lp ON lp.user_id = u.id
         LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE u.is_active = 1 AND (u.role = 'student' OR lp.id IS NOT NULL) ${searchSql}
        GROUP BY u.id, u.email, up.avatar_url
        ORDER BY leaderboard_points DESC, u.id ASC
        LIMIT ${limit}`,
      params
    ));
    const leaderboard = rows.map((r) => ({ ...r, leaderboard_points: Number(r.leaderboard_points), avatar_url: absAvatar(req, r.avatar_url) }));
    return res.json({ success: true, data: { leaderboard, total: leaderboard.length } });
  } catch (error) {
    return serverError(req, res, "getAdminLeaderboard", error);
  }
};

// POST /api/admin/leaderboard/adjust   { user_id, points (± entier), reason }
export const adjustPoints = async (req: Req, res: Response) => {
  try {
    const userId = parseId(req.body?.user_id);
    const points = Number(req.body?.points);
    const reason = String(req.body?.reason ?? "").trim().slice(0, 255);
    if (!userId) return fail(req, res, 400, "Utilisateur invalide", "Invalid user");
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100000) {
      return fail(req, res, 400, "Le nombre de points doit être un entier non nul (max 100 000)", "Points must be a non-zero integer (max 100,000)");
    }
    const [user]: any = await query("SELECT id, first_name, last_name FROM users WHERE id = ?", [userId]);
    if (!user) return fail(req, res, 404, "Utilisateur introuvable", "User not found");

    const [{ total: before }]: any = await query(
      "SELECT COALESCE(SUM(points), 0) AS total FROM leaderboard_points WHERE user_id = ?", [userId]
    );
    const result: any = await query(
      `INSERT INTO leaderboard_points (user_id, points, source, related_id, related_type)
       VALUES (?, ?, 'admin_adjustment', ?, 'admin_adjustment')`,
      [userId, points, req.user!.id]
    );
    const after = Number(before) + points;
    await logAudit(req, "admin", "leaderboard.adjusted", "user", userId,
      { points_total: Number(before) }, { points_total: after, delta: points, reason: reason || null, entry_id: Number(result.insertId) });

    return res.json({
      success: true,
      message: tr(req, "Points ajustés", "Points adjusted"),
      data: { user_id: userId, delta: points, leaderboard_points: after, entry_id: Number(result.insertId) },
    });
  } catch (error) {
    return serverError(req, res, "adjustPoints", error);
  }
};

// POST /api/admin/leaderboard/reset   (supprime tout le journal de points)
export const resetLeaderboard = async (req: Req, res: Response) => {
  try {
    const [{ n, total }]: any = await query("SELECT COUNT(*) AS n, COALESCE(SUM(points), 0) AS total FROM leaderboard_points");
    await query("DELETE FROM leaderboard_points");
    await logAudit(req, "admin", "leaderboard.reset", "leaderboard", null,
      { entries: Number(n), points_total: Number(total) }, { entries: 0 });
    return res.json({
      success: true,
      message: tr(req, "Classement réinitialisé", "Leaderboard reset"),
      data: { deleted: Number(n) },
    });
  } catch (error) {
    return serverError(req, res, "resetLeaderboard", error);
  }
};
