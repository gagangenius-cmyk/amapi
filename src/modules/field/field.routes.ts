import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env';
import { Conn, exec, pool, q, q1, withTx } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../utils/audit';
import { AppError, asyncHandler, notFound } from '../../utils/errors';
import { idParam } from '../../utils/http';
import { assertSubscriptionActive } from '../distributors/subscription';

/**
 * FIELD SALES
 *  - a retailer sets the shop's location once, and shows a short-lived QR in its own app;
 *  - the distributor plans beats (an employee, a weekday, an ordered list of shops) and can change them any time;
 *  - the employee scans the shop's QR to punch the visit, and uses the map list (nearest first) to find, call and navigate to shops;
 *  - every shop gets a performance colour from how recently it ordered.
 */
export const fieldRouter = Router();
fieldRouter.use(authenticate);

const VISIT_CODE_TTL_S = 180;
const NEAR_METRES = 300;
const IST_MS = 5.5 * 3600_000;
const todayIstWeekday = (now = Date.now()) => new Date(now + IST_MS).getUTCDay(); // 0 = Sunday

// ---------------------------------------------------------------------------------------------
// Performance colour: how recently has this shop ordered?
// ---------------------------------------------------------------------------------------------
export type Colour = 'green' | 'amber' | 'red' | 'grey';
export function performanceOf(lastOrderAt: Date | string | null, now = Date.now()): { colour: Colour; label: string; days_since_order: number | null } {
  if (!lastOrderAt) return { colour: 'grey', label: 'No orders yet', days_since_order: null };
  const days = Math.floor((now - +new Date(lastOrderAt)) / 86_400_000);
  if (days <= 15) return { colour: 'green', label: 'Ordering well', days_since_order: days };
  if (days <= 45) return { colour: 'amber', label: 'Slowing down', days_since_order: days };
  return { colour: 'red', label: 'At risk: no recent orders', days_since_order: days };
}

/** Straight-line distance in metres between two points. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180; const R = 6_371_000;
  const dLat = (bLat - aLat) * rad; const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

const latlng = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });

// ---------------------------------------------------------------------------------------------
// Retailer: shop location (once) and the visit QR
// ---------------------------------------------------------------------------------------------
fieldRouter.get('/shop-location', requireRole('retailer'), asyncHandler(async (req, res) => {
  const r = await q1<any>(pool, 'SELECT lat, lng, location_set_at FROM retailer_profiles WHERE user_id = ?', [req.auth!.userId]);
  res.json({ lat: r?.lat == null ? null : Number(r.lat), lng: r?.lng == null ? null : Number(r.lng), set_at: r?.location_set_at ?? null, locked: r?.lat != null });
}));

fieldRouter.put('/shop-location', requireRole('retailer'), asyncHandler(async (req, res) => {
  const b = latlng.parse(req.body);
  const id = req.auth!.userId;
  const done = await exec(pool, 'UPDATE retailer_profiles SET lat = ?, lng = ?, location_set_at = UTC_TIMESTAMP() WHERE user_id = ? AND lat IS NULL', [b.lat, b.lng, id]);
  if (!done.affectedRows) throw new AppError(409, 'LOCATION_LOCKED', 'Your shop location is already set. Ask your distributor to reset it if it is wrong.');
  await audit(id, 'retailer.shop_location_set', 'user', id, { lat: b.lat, lng: b.lng });
  res.json({ lat: b.lat, lng: b.lng, locked: true });
}));

/** A code that proves "I am standing in this shop right now": valid for three minutes, so a screenshot is useless later. */
fieldRouter.get('/visit-code', requireRole('retailer'), asyncHandler(async (req, res) => {
  const code = jwt.sign({ purpose: 'visit', r: req.auth!.userId }, env.jwtSecret, { expiresIn: VISIT_CODE_TTL_S });
  res.json({ code: `aayme-visit:${code}`, expires_in: VISIT_CODE_TTL_S });
}));

// ---------------------------------------------------------------------------------------------
// Shared: the shops a distributor (all of them) or an employee (theirs) works with
// ---------------------------------------------------------------------------------------------
async function shopsFor(distributorId: number, employeeId: number | null) {
  const own = employeeId == null ? '' : `AND (u.managed_by_id = ? OR u.id IN (SELECT bpr.retailer_id FROM beat_plan_retailers bpr JOIN beat_plans bp ON bp.id = bpr.beat_id WHERE bp.employee_id = ? AND bp.is_active = 1))`;
  const args: unknown[] = [distributorId, distributorId, distributorId];
  if (employeeId != null) args.push(employeeId, employeeId);
  const rows = await q<any>(pool, `
    SELECT u.id, u.name owner_name, u.phone, u.managed_by_id, rp.shop_name, rp.address, rp.pincode, rp.lat, rp.lng,
      (SELECT MAX(o.created_at) FROM orders o WHERE o.retailer_id = u.id AND o.distributor_id = ? AND o.status NOT IN ('rejected','cancelled')) last_order_at,
      (SELECT MAX(v.visited_at) FROM visits v WHERE v.retailer_id = u.id AND v.distributor_id = ?) last_visit_at
    FROM retailer_distributor_relations rdr JOIN users u ON u.id = rdr.retailer_id JOIN retailer_profiles rp ON rp.user_id = u.id
    WHERE rdr.distributor_id = ? AND rdr.status = 'active' AND u.is_active = 1 ${own}
    ORDER BY rp.shop_name`, args);
  return rows.map((r) => ({
    id: r.id as number, shop_name: r.shop_name as string, owner_name: r.owner_name as string, phone: r.phone as string, address: r.address ?? null, pincode: r.pincode as string,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), located: r.lat != null,
    managed_by_id: r.managed_by_id ?? null, last_order_at: r.last_order_at ?? null, last_visit_at: r.last_visit_at ?? null,
    performance: performanceOf(r.last_order_at),
  }));
}

const distributorOf = (req: any): number => req.auth.distributorId as number;
const isEmployee = (req: any) => req.auth.role === 'employee';

/** Map list: shops with their location, performance colour, phone and a directions link; nearest first when the caller sends their own position. */
fieldRouter.get('/map', requireRole('distributor', 'employee'), asyncHandler(async (req, res) => {
  const pos = z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }).parse(req.query);
  const shops = await shopsFor(distributorOf(req), isEmployee(req) ? req.auth!.userId : null);
  const withDistance = shops.map((s) => {
    const distance_m = pos.lat != null && pos.lng != null && s.located ? metresBetween(pos.lat, pos.lng, s.lat!, s.lng!) : null;
    return { ...s, distance_m, directions_url: s.located ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}` : null };
  });
  // ascending by distance (shops without a location go last, by name)
  withDistance.sort((a, b) => (a.distance_m == null ? 1 : 0) - (b.distance_m == null ? 1 : 0) || (a.distance_m ?? 0) - (b.distance_m ?? 0) || a.shop_name.localeCompare(b.shop_name));
  res.json({ shops: withDistance, located: withDistance.filter((s) => s.located).length, total: withDistance.length });
}));

// ---------------------------------------------------------------------------------------------
// Distributor: beat plans (create, change, delete) and their shops
// ---------------------------------------------------------------------------------------------
const beatBody = z.object({
  name: z.string().trim().min(2).max(80),
  employee_id: z.number().int().positive(),
  weekday: z.number().int().min(0).max(6),
  retailer_ids: z.array(z.number().int().positive()).max(300).default([]),
  is_active: z.boolean().default(true),
});

async function assertBeatPeople(c: Conn, d: number, employeeId: number | undefined, retailerIds: number[] | undefined) {
  if (employeeId !== undefined && !(await q1(c, "SELECT id FROM users WHERE id = ? AND role = 'employee' AND owner_distributor_id = ? AND is_active = 1", [employeeId, d]))) {
    throw new AppError(400, 'BAD_EMPLOYEE', 'Choose one of your active team members');
  }
  if (retailerIds?.length) {
    const ok = await q<any>(c, "SELECT retailer_id FROM retailer_distributor_relations WHERE distributor_id = ? AND status = 'active' AND retailer_id IN (?)", [d, retailerIds]);
    if (new Set(ok.map((r) => r.retailer_id)).size !== new Set(retailerIds).size) throw new AppError(400, 'BAD_RETAILER', 'Every shop must be one of your connected retailers');
  }
}

async function presentBeats(d: number, where = '', args: unknown[] = []) {
  const beats = await q<any>(pool, `SELECT bp.*, u.name employee_name FROM beat_plans bp JOIN users u ON u.id = bp.employee_id WHERE bp.distributor_id = ? ${where} ORDER BY bp.weekday, bp.name`, [d, ...args]);
  if (!beats.length) return [];
  const rows = await q<any>(pool, `SELECT bpr.beat_id, bpr.retailer_id, rp.shop_name FROM beat_plan_retailers bpr JOIN retailer_profiles rp ON rp.user_id = bpr.retailer_id WHERE bpr.beat_id IN (?) ORDER BY bpr.sort_order`, [beats.map((b) => b.id)]);
  return beats.map((b) => ({
    id: b.id, name: b.name, employee_id: b.employee_id, employee_name: b.employee_name, weekday: b.weekday, is_active: !!b.is_active,
    retailers: rows.filter((r) => r.beat_id === b.id).map((r) => ({ id: r.retailer_id, shop_name: r.shop_name })),
  }));
}

fieldRouter.get('/beats', requireRole('distributor'), asyncHandler(async (req, res) => {
  res.json({ beats: await presentBeats(req.auth!.userId) });
}));

/** Everything the plan editor needs: the team and the shops (with colour and location status). */
fieldRouter.get('/beats/options', requireRole('distributor'), asyncHandler(async (req, res) => {
  const d = req.auth!.userId;
  const [team, shops] = await Promise.all([
    q<any>(pool, "SELECT id, name, phone FROM users WHERE role = 'employee' AND owner_distributor_id = ? AND is_active = 1 ORDER BY name", [d]),
    shopsFor(d, null),
  ]);
  res.json({ employees: team, shops });
}));

fieldRouter.post('/beats', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = beatBody.parse(req.body);
  const d = req.auth!.userId;
  await assertSubscriptionActive(pool, d);
  await assertBeatPeople(pool, d, b.employee_id, b.retailer_ids);
  const id = await withTx(async (c) => {
    const r = await exec(c, 'INSERT INTO beat_plans (distributor_id, employee_id, name, weekday, is_active, created_by) VALUES (?,?,?,?,?,?)', [d, b.employee_id, b.name, b.weekday, b.is_active ? 1 : 0, d]);
    const ids = [...new Set(b.retailer_ids)];
    if (ids.length) await exec(c, 'INSERT INTO beat_plan_retailers (beat_id, retailer_id, sort_order) VALUES ?', [ids.map((rid, i) => [r.insertId, rid, i])]);
    return r.insertId as number;
  });
  await audit(d, 'beat.create', 'beat', id, { employee_id: b.employee_id, weekday: b.weekday, shops: b.retailer_ids.length });
  res.status(201).json((await presentBeats(d, 'AND bp.id = ?', [id]))[0]);
}));

fieldRouter.put('/beats/:id', requireRole('distributor'), asyncHandler(async (req, res) => {
  const b = beatBody.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
  const d = req.auth!.userId; const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT * FROM beat_plans WHERE id = ? AND distributor_id = ?', [id, d]);
  if (!cur) throw notFound('Beat plan');
  await assertSubscriptionActive(pool, d);
  await assertBeatPeople(pool, d, b.employee_id, b.retailer_ids);
  await withTx(async (c) => {
    await exec(c, 'UPDATE beat_plans SET name = ?, employee_id = ?, weekday = ?, is_active = ? WHERE id = ?', [
      b.name ?? cur.name, b.employee_id ?? cur.employee_id, b.weekday ?? cur.weekday, b.is_active === undefined ? cur.is_active : b.is_active ? 1 : 0, id,
    ]);
    if (b.retailer_ids) {
      await exec(c, 'DELETE FROM beat_plan_retailers WHERE beat_id = ?', [id]);
      const ids = [...new Set(b.retailer_ids)];
      if (ids.length) await exec(c, 'INSERT INTO beat_plan_retailers (beat_id, retailer_id, sort_order) VALUES ?', [ids.map((rid, i) => [id, rid, i])]);
    }
  });
  await audit(d, 'beat.update', 'beat', id, { ...b, retailer_ids: b.retailer_ids ? `${b.retailer_ids.length} shops` : undefined });
  res.json((await presentBeats(d, 'AND bp.id = ?', [id]))[0]);
}));

fieldRouter.delete('/beats/:id', requireRole('distributor'), asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  const cur = await q1<any>(pool, 'SELECT id FROM beat_plans WHERE id = ? AND distributor_id = ?', [id, d]);
  if (!cur) throw notFound('Beat plan');
  await exec(pool, 'DELETE FROM beat_plan_retailers WHERE beat_id = ?', [id]);
  await exec(pool, 'UPDATE visits SET beat_id = NULL WHERE beat_id = ?', [id]);
  await exec(pool, 'DELETE FROM beat_plans WHERE id = ?', [id]);
  await audit(d, 'beat.delete', 'beat', id, {});
  res.status(204).end();
}));

/** A wrong shop location can only be fixed by the distributor resetting it; the retailer then sets it again from the shop. */
fieldRouter.post('/retailers/:id/location/reset', requireRole('distributor'), asyncHandler(async (req, res) => {
  const d = req.auth!.userId; const id = idParam(req);
  if (!(await q1(pool, "SELECT 1 FROM retailer_distributor_relations WHERE distributor_id = ? AND retailer_id = ? AND status = 'active'", [d, id]))) throw notFound('Retailer');
  await exec(pool, 'UPDATE retailer_profiles SET lat = NULL, lng = NULL, location_set_at = NULL WHERE user_id = ?', [id]);
  await audit(d, 'retailer.shop_location_reset', 'user', id, {});
  res.json({ reset: true });
}));

fieldRouter.get('/visits', requireRole('distributor'), asyncHandler(async (req, res) => {
  const qs = z.object({ employee_id: z.coerce.number().int().positive().optional(), days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
  const d = req.auth!.userId;
  const rows = await q<any>(pool, `SELECT v.id, v.employee_id, e.name employee_name, v.retailer_id, rp.shop_name, v.visited_at, v.distance_m, v.beat_id
    FROM visits v JOIN users e ON e.id = v.employee_id JOIN retailer_profiles rp ON rp.user_id = v.retailer_id
    WHERE v.distributor_id = ? AND v.visited_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) ${qs.employee_id ? 'AND v.employee_id = ?' : ''}
    ORDER BY v.id DESC LIMIT 300`, qs.employee_id ? [d, qs.days, qs.employee_id] : [d, qs.days]);
  res.json({ visits: rows.map((r) => ({ ...r, near: r.distance_m != null && r.distance_m <= NEAR_METRES })) });
}));

// ---------------------------------------------------------------------------------------------
// Employee: today's route, and punching a visit by scanning the shop's QR
// ---------------------------------------------------------------------------------------------
fieldRouter.get('/today', requireRole('employee'), asyncHandler(async (req, res) => {
  const e = req.auth!.userId; const d = distributorOf(req);
  const weekday = todayIstWeekday();
  const beats = await presentBeats(d, 'AND bp.employee_id = ? AND bp.weekday = ? AND bp.is_active = 1', [e, weekday]);
  const visited = await q<any>(pool, `SELECT retailer_id, MAX(visited_at) at FROM visits WHERE employee_id = ? AND visited_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 18 HOUR) GROUP BY retailer_id`, [e]);
  const seen = new Map(visited.map((v) => [v.retailer_id, v.at]));
  const shops = new Map((await shopsFor(d, null)).map((s) => [s.id, s]));
  res.json({
    weekday,
    beats: beats.map((b) => ({
      ...b,
      retailers: b.retailers.map((r: any) => ({ ...r, ...(shops.get(r.id) ?? {}), visited_at: seen.get(r.id) ?? null })),
    })),
  });
}));

fieldRouter.post('/punch', requireRole('employee'), asyncHandler(async (req, res) => {
  const b = z.object({ code: z.string().min(20).max(1000), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).parse(req.body);
  const e = req.auth!.userId; const d = distributorOf(req);
  let retailerId: number;
  try {
    const p = jwt.verify(b.code.replace(/^aayme-visit:/, ''), env.jwtSecret) as any;
    if (p.purpose !== 'visit' || !Number.isInteger(p.r)) throw new Error('not a visit code');
    retailerId = p.r;
  } catch { throw new AppError(400, 'BAD_VISIT_CODE', 'This QR is not valid or has expired. Ask the retailer to open a fresh one in their app.'); }

  await assertSubscriptionActive(pool, d);
  const shop = await q1<any>(pool, `SELECT rp.shop_name, rp.lat, rp.lng FROM retailer_distributor_relations rdr JOIN retailer_profiles rp ON rp.user_id = rdr.retailer_id
    WHERE rdr.distributor_id = ? AND rdr.retailer_id = ? AND rdr.status = 'active'`, [d, retailerId]);
  if (!shop) throw new AppError(403, 'NOT_YOUR_SHOP', 'This shop is not one of your distributor\'s retailers');

  // the same visit scanned twice in ten minutes is one visit
  const dup = await q1<any>(pool, 'SELECT id, visited_at, distance_m FROM visits WHERE employee_id = ? AND retailer_id = ? AND visited_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) ORDER BY id DESC LIMIT 1', [e, retailerId]);
  if (dup) return void res.json({ id: dup.id, shop_name: shop.shop_name, visited_at: dup.visited_at, distance_m: dup.distance_m, near: dup.distance_m != null && dup.distance_m <= NEAR_METRES, repeated: true });

  const distance = b.lat != null && b.lng != null && shop.lat != null ? metresBetween(b.lat, b.lng, Number(shop.lat), Number(shop.lng)) : null;
  const today = todayIstWeekday();
  const planned = await q1<any>(pool, `SELECT bp.id FROM beat_plans bp JOIN beat_plan_retailers bpr ON bpr.beat_id = bp.id
    WHERE bp.employee_id = ? AND bp.weekday = ? AND bp.is_active = 1 AND bpr.retailer_id = ? LIMIT 1`, [e, today, retailerId]);
  const ins = await exec(pool, 'INSERT INTO visits (distributor_id, employee_id, retailer_id, beat_id, lat, lng, distance_m) VALUES (?,?,?,?,?,?,?)', [d, e, retailerId, planned?.id ?? null, b.lat ?? null, b.lng ?? null, distance]);
  await audit(e, 'visit.punch', 'user', retailerId, { visit_id: ins.insertId, distance_m: distance, planned: !!planned });
  res.status(201).json({ id: ins.insertId, shop_name: shop.shop_name, visited_at: new Date().toISOString(), distance_m: distance, near: distance != null && distance <= NEAR_METRES, planned: !!planned, repeated: false });
}));
