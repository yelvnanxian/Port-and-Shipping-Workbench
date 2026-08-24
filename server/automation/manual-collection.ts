import crypto from 'node:crypto';
import type { AuthUser } from '../auth.js';
import type { AutomationEngine } from './engine.js';
import type { TrackingQuery } from './types.js';

export type ManualCollectionCarrier = 'CMA' | 'HAPAG';
export type ManualCollectionStatus = 'pending' | 'success' | 'failed';

export interface ManualCollectionSession {
  id: string;
  token: string;
  userId: string;
  engine: AutomationEngine;
  carrierCode: ManualCollectionCarrier;
  carrierName: string;
  shipmentId: string;
  rowNumber: number;
  billNo: string;
  queryBillNo: string;
  containerNo: string;
  queryType: TrackingQuery['queryType'];
  sourceUrl: string;
  createdAt: string;
  expiresAt: string;
  status: ManualCollectionStatus;
  attempts: number;
  lastError?: string;
  completedAt?: string;
  result?: { arrivalKind: 'ATA' | 'ETA' | null; arrived: boolean; discharged: boolean; evidencePath?: string };
}

export interface PublicManualCollectionSession {
  id: string;
  token: string;
  carrierCode: ManualCollectionCarrier;
  carrierName: string;
  shipmentId: string;
  billNo: string;
  queryBillNo: string;
  containerNo: string;
  queryType: TrackingQuery['queryType'];
  sourceUrl: string;
  createdAt: string;
  expiresAt: string;
  status: ManualCollectionStatus;
  attempts: number;
  lastError?: string;
  completedAt?: string;
  result?: ManualCollectionSession['result'];
}

function publicSession(session: ManualCollectionSession): PublicManualCollectionSession {
  const { engine: _engine, userId: _userId, rowNumber: _rowNumber, ...view } = session;
  return view;
}

/**
 * Manual browser collection is intentionally short-lived and in-memory.
 * The token is scoped to one workbook row and one query type; it is never
 * written to disk and is invalidated after a successful submission.
 */
export class ManualCollectionRegistry {
  private readonly sessions = new Map<string, ManualCollectionSession>();

  create(input: Omit<ManualCollectionSession, 'id' | 'token' | 'createdAt' | 'expiresAt' | 'status' | 'attempts'>, ttlMs = 15 * 60_000) {
    this.cleanup();
    const createdAt = new Date();
    const session: ManualCollectionSession = {
      ...input,
      id: `MC-${createdAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(5).toString('hex')}`,
      token: crypto.randomBytes(32).toString('base64url'),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      status: 'pending',
      attempts: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  findById(id: string, userId?: string) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session || (userId && session.userId !== userId)) return undefined;
    return session;
  }

  findByToken(token: string) {
    this.cleanup();
    for (const session of this.sessions.values()) if (session.token === token) return session;
    return undefined;
  }

  view(session: ManualCollectionSession) {
    return publicSession(session);
  }

  markAttempt(session: ManualCollectionSession, error?: string) {
    session.attempts += 1;
    session.lastError = error?.slice(0, 500);
    session.status = 'pending';
  }

  markSuccess(session: ManualCollectionSession, result: NonNullable<ManualCollectionSession['result']>) {
    session.status = 'success';
    session.completedAt = new Date().toISOString();
    session.lastError = undefined;
    session.result = result;
  }

  markFailure(session: ManualCollectionSession, error: string) {
    session.status = 'failed';
    session.completedAt = new Date().toISOString();
    session.lastError = error.slice(0, 500);
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now || (session.status === 'success' && Date.parse(session.completedAt || '') + 60_000 <= now)) {
        this.sessions.delete(id);
      }
    }
  }
}

export function isManualCollectionCarrier(value: string): value is ManualCollectionCarrier {
  return value === 'CMA' || value === 'HAPAG';
}

export function manualCollectionHostAllowed(carrierCode: ManualCollectionCarrier, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (carrierCode === 'CMA') return hostname === 'cma-cgm.com' || hostname.endsWith('.cma-cgm.com');
    return hostname === 'hapag-lloyd.com'
      || hostname.endsWith('.hapag-lloyd.com')
      || hostname === 'hapag-lloyd.cn'
      || hostname.endsWith('.hapag-lloyd.cn');
  } catch {
    return false;
  }
}

export function manualCollectionUserId(user: AuthUser | undefined) {
  return user?.id || 'local-admin';
}
