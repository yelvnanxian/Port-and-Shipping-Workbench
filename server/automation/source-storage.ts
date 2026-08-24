import path from 'node:path';

/**
 * Runtime files are separated by carrier.  The legacy directories remain
 * readable so existing cookies and screenshots are not lost during upgrade.
 */
export function safeSourceCode(value: string) {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  return normalized || 'UNKNOWN';
}

export function sourceDirectory(dataDirectory: string, carrierCode: string) {
  return path.join(dataDirectory, 'sources', safeSourceCode(carrierCode));
}

export function sourceEvidenceDirectory(dataDirectory: string, carrierCode: string) {
  return path.join(sourceDirectory(dataDirectory, carrierCode), 'evidence');
}

export function sourceStatePath(dataDirectory: string, carrierCode: string) {
  return path.join(sourceDirectory(dataDirectory, carrierCode), 'browser-state', `${safeSourceCode(carrierCode)}.json`);
}

export function legacyEvidenceDirectory(dataDirectory: string) {
  return path.join(dataDirectory, 'browser-evidence');
}

export function legacyStatePath(dataDirectory: string, carrierCode: string) {
  return path.join(dataDirectory, 'browser-state', `${safeSourceCode(carrierCode)}.json`);
}

export function sourceEvidenceUrl(carrierCode: string, fileName: string) {
  return `/api/browser-evidence/${encodeURIComponent(safeSourceCode(carrierCode))}/${encodeURIComponent(fileName)}`;
}

export function sourceTrackingDetailDirectory(dataDirectory: string, carrierCode: string) {
  return path.join(sourceDirectory(dataDirectory, carrierCode), 'tracking-details');
}

export function sourceTrackingDetailKey(billNo: string, containerNo = '') {
  const normalized = `${billNo.trim().toUpperCase()}_${containerNo.trim().toUpperCase()}`
    .replace(/[^A-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.slice(0, 120) || 'UNKNOWN';
}

export function sourceTrackingDetailPath(dataDirectory: string, carrierCode: string, key: string) {
  return path.join(sourceTrackingDetailDirectory(dataDirectory, carrierCode), `${safeSourceCode(key)}.json`);
}

export function sourceTrackingDetailUrl(carrierCode: string, key: string) {
  return `/api/tracking-details/${encodeURIComponent(safeSourceCode(carrierCode))}/${encodeURIComponent(`${safeSourceCode(key)}.json`)}`;
}

/** Accept both the new carrier-specific URL and the old flat URL. */
export function evidenceFileNameFromUrl(value: string) {
  const match = value.match(/^\/api\/browser-evidence\/(?:[^/]+\/)?([^/?#]+)$/i);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}
