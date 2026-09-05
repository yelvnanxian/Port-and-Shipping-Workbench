import path from 'node:path';
import fs from 'node:fs/promises';

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

/**
 * Evidence is deliberately keyed by the carrier and the queried bill/container.
 * A query may be retried several times, but only the newest screenshot is useful
 * for review; keeping every retry quickly makes the local data directory grow.
 */
export function evidenceReference(value: string, maxLength = 32) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, maxLength) || 'UNKNOWN';
}

export function evidenceFileKey(carrierCode: string, reference: string) {
  return `${safeSourceCode(carrierCode)}_${evidenceReference(reference)}`;
}

function evidenceNameMatches(name: string, carrierCode: string, reference: string) {
  const stem = name.replace(/\.(?:png|svg)$/i, '');
  const parts = stem.split('_');
  if (parts.length < 3) return false;
  // Filenames are timestamp_carrier_reference_suffix.ext. The reference itself
  // is normalized, so matching the first two semantic fields is unambiguous.
  const storedReference = parts.slice(2).join('_').toUpperCase();
  const normalizedPair = evidenceReference(reference);
  const aliases = reference.split(/[_\s]+/).map((value) => evidenceReference(value)).filter(Boolean);
  return parts[1].toUpperCase() === safeSourceCode(carrierCode)
    && (storedReference === normalizedPair
      || storedReference.startsWith(`${normalizedPair}_`)
      || aliases.some((alias) => storedReference === alias || storedReference.startsWith(`${alias}_`)));
}

/** Remove older evidence for one carrier/reference, preserving the newly written file. */
export async function removeOlderEvidence(
  directory: string,
  carrierCode: string,
  reference: string,
  keepFileName: string,
) {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === keepFileName || !/\.(?:png|svg)$/i.test(entry.name)) continue;
    if (!evidenceNameMatches(entry.name, carrierCode, reference)) continue;
    await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

type ScreenshotPage = { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown> };

/** Shared screenshot writer used by normal and Patchright providers. */
export async function saveEvidenceScreenshot(
  page: ScreenshotPage,
  dataDirectory: string,
  carrierCode: string,
  reference: string,
  label: string,
) {
  const directory = sourceEvidenceDirectory(dataDirectory, carrierCode);
  await fs.mkdir(directory, { recursive: true });
  const normalizedReference = evidenceReference(reference, 64);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeSourceCode(carrierCode)}_${normalizedReference}_${label}.png`;
  try {
    await page.screenshot({ path: path.join(directory, fileName), fullPage: true });
    await removeOlderEvidence(directory, carrierCode, reference, fileName);
    return sourceEvidenceUrl(carrierCode, fileName);
  } catch {
    return undefined;
  }
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
