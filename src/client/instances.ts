/**
 * Curated community-instance snapshot (searx.space) for the card picker.
 * Bundled into lib/client.js by esbuild — the card works offline from the
 * snapshot date. Refresh with `make update-instances` on a connected machine.
 */

import raw from './instances.snapshot.json'

export type SnapshotInstance = {
  url: string
  status: 'up' | 'unknown'
  uptimePct: number | null
  latencyMs: number | null
  version: string | null
}

export type SnapshotFile = {
  updatedAt: string | null
  source: string
  note: string
  instances: SnapshotInstance[]
}

const snapshot = (raw as unknown) as SnapshotFile

export function getSnapshot(): SnapshotFile {
  return snapshot
}

/** Snapshot older than this is flagged stale in the card (ms). */
const STALE_AFTER_MS = 30 * 24 * 3600 * 1000

export function snapshotLabel(): string | null {
  if (!snapshot.updatedAt) return null
  const t = Date.parse(snapshot.updatedAt)
  if (Number.isNaN(t)) return snapshot.updatedAt
  return new Date(t).toLocaleDateString()
}

export function isSnapshotStale(now = Date.now()): boolean {
  if (!snapshot.updatedAt) return true
  const t = Date.parse(snapshot.updatedAt)
  return Number.isNaN(t) || now - t > STALE_AFTER_MS
}

/** One-line meta for a picker row, skipping unknown fields. */
export function instanceMeta(i: SnapshotInstance): string {
  const parts: string[] = [i.status === 'up' ? '在线' : '状态未知']
  if (i.uptimePct !== null) parts.push(`在线率 ${i.uptimePct}%`)
  if (i.latencyMs !== null) parts.push(`${i.latencyMs}ms`)
  if (i.version) parts.push(`v${i.version}`)
  return parts.join(' · ')
}
