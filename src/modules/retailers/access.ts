import { env } from '../../config/env';
import { Conn, q, q1 } from '../../db/pool';
import { DEFAULT_PERMISSIONS } from '../distributors/subscription';

/**
 * Who may see a distributor's store and order from it.
 *   linked   - the retailer and distributor are connected (the retailer accepted, or chose them)
 *   invited  - the distributor invited the retailer and they have not answered yet
 *   pincode  - not connected, but the distributor sells in the retailer's pincode AND has pincode selling switched on
 * Anyone else gets nothing: a distributor's products are not public.
 * The distributor's subscription must be live in every case.
 */
export type Access = 'linked' | 'invited' | 'pincode';

export async function storeAccess(c: Conn, retailerId: number, distributorId: number): Promise<Access | null> {
  const d = await q1<any>(c, 'SELECT permissions, subscription_ends_at FROM distributor_profiles WHERE user_id = ?', [distributorId]);
  if (!d || (!env.freeOnboarding && new Date(d.subscription_ends_at).getTime() < Date.now())) return null; // free testing period: no expiry
  const rel = await q1<any>(c, 'SELECT status, requested_by FROM retailer_distributor_relations WHERE retailer_id = ? AND distributor_id = ?', [retailerId, distributorId]);
  if (rel?.status === 'active') return 'linked';
  if (rel?.status === 'pending' && rel.requested_by === 'distributor') return 'invited';
  const perms = { ...DEFAULT_PERMISSIONS, ...JSON.parse(d.permissions) };
  if (!perms.pincode_selling) return null;
  const hit = await q1(c, 'SELECT 1 FROM service_pincodes sp JOIN retailer_profiles rp ON rp.pincode = sp.pincode WHERE sp.distributor_id = ? AND rp.user_id = ?', [distributorId, retailerId]);
  return hit ? 'pincode' : null;
}

/** Distributors that sell in this retailer's pincode with pincode selling on, minus the ones already connected. */
export async function nearbyDistributors(c: Conn, retailerId: number, pincode: string) {
  const rows = await q<any>(c, `
    SELECT dp.user_id id, dp.business_name, dp.city, dp.permissions FROM service_pincodes sp
    JOIN distributor_profiles dp ON dp.user_id = sp.distributor_id
    WHERE sp.pincode = ? AND (? OR dp.subscription_ends_at > UTC_TIMESTAMP())
      AND NOT EXISTS (SELECT 1 FROM retailer_distributor_relations r WHERE r.retailer_id = ? AND r.distributor_id = dp.user_id AND r.status = 'active')
    ORDER BY dp.business_name`, [pincode, env.freeOnboarding ? 1 : 0, retailerId]);
  return rows.filter((r) => ({ ...DEFAULT_PERMISSIONS, ...JSON.parse(r.permissions) }).pincode_selling);
}
