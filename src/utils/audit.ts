import { Conn, exec, pool } from '../db/pool';
import { logger } from './logger';

/** Append-only trail of security/financial actions. Never lets an audit failure break the request. */
export async function audit(actorId: number | null, action: string, entity: string, entityId: number | null, meta: unknown = {}, c: Conn = pool) {
  try {
    await exec(c, 'INSERT INTO audit_log (actor_id, action, entity, entity_id, meta) VALUES (?,?,?,?,?)', [actorId, action, entity, entityId, JSON.stringify(meta)]);
  } catch (err) {
    logger.error({ err, action }, 'audit write failed');
  }
}
