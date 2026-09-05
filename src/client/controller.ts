/**
 * Client controller for the searxng settings card.
 * Binds to the `searxng` namespace via ctx.settingsScope and exposes
 * a small observable store for the card.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

export type SearxngConfig = {
  baseURL: string
  username: string
  password: string
  categories: string
  language: string
  safesearch: number
  proxyUrl: string
}

export const SEARXNG_FIELD_KEYS = [
  'baseURL',
  'username',
  'password',
  'categories',
  'language',
  'safesearch',
  'proxyUrl',
] as const

export type SearxngSnapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  value?: SearxngConfig
  revision?: number
  writable: boolean
  error?: string
}

/**
 * Connectivity probe faces. Mirror `src/host/probe.ts` (`ProbeTarget` /
 * `ProbeTargetResult`) without importing it: the client bundle compiles only
 * `src/client/**`, and this file intentionally duplicates the two shapes
 * (same precedent as `validateConfig` mirroring the host schema).
 *
 * Transport (see `src/host/probe.ts`): the card writes a request into the
 * `searxng-probe` settings section and the host writes the result back.
 * No host↔client RPC — the client platform gates `ctx.remote.<ns>` property
 * access by fiber injects that third-party entries cannot satisfy.
 */
export type ProbeTarget = {
  url: string
  username?: string
  password?: string
  categories?: string
  language?: string
  safesearch?: number
}

export type ProbeTargetResult = {
  url: string
  ok: boolean
  latencyMs: number
  resultCount: number
  firstTitle?: string
  firstUrl?: string
  error?: string
}

/** Settings namespace carrying probe requests and results (see host). */
export const PROBE_NS = 'searxng-probe'
/** Upper bound for one batch round (host caps too). */
export const PROBE_MAX_TARGETS = 12
/** Round-trip wait before the card reports "no answer" (host fans out in parallel). */
export const PROBE_ROUND_TIMEOUT_MS = 50_000

/** Runtime community-list cache + refresh channel (see host instances.ts). */
export const INSTANCES_NS = 'searxng-instances'
/** Refresh wait (host fetches searx.space with a 30s cap, then curates). */
export const INSTANCES_REFRESH_TIMEOUT_MS = 60_000

export type RefreshedInstance = {
  url: string
  status: 'up' | 'unknown'
  uptimePct: number | null
  latencyMs: number | null
  version: string | null
}

export type InstancesCache = {
  instances: RefreshedInstance[]
  fetchedAt: string
}

type Listener = () => void

export function defaultConfig(): SearxngConfig {
  return {
    baseURL: '',
    username: '',
    password: '',
    categories: 'general',
    language: 'zh-CN',
    safesearch: 1,
    proxyUrl: '',
  }
}

/** Local validation mirroring the host schema (fast feedback before save). */
export function validateConfig(cfg: SearxngConfig): Partial<Record<keyof SearxngConfig, string>> {
  const errors: Partial<Record<keyof SearxngConfig, string>> = {}
  if (cfg.baseURL !== '' && !canParseUrl(cfg.baseURL)) errors.baseURL = 'invalid-url'
  if (![0, 1, 2].includes(cfg.safesearch)) errors.safesearch = 'invalid-range'
  if (cfg.proxyUrl !== '' && !isValidProxy(cfg.proxyUrl)) errors.proxyUrl = 'invalid-proxy'
  return errors
}

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'])

function isValidProxy(v: string): boolean {
  try {
    return PROXY_SCHEMES.has(new URL(v).protocol)
  } catch {
    return false
  }
}

function canParseUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export class SearxngController {
  private listeners = new Set<Listener>()
  private snapshot: SearxngSnapshot = { status: 'loading', writable: false }
  private unsub?: () => void
  private probeScope?: any
  private probeScopeFailed = false
  private probeUnsubs = new Set<() => void>()

  constructor(
    private readonly scope: SettingsScope<SearxngConfig>,
    private readonly settingsScope?: any,
  ) {}

  bind(): void {
    this.unsub = this.scope.subscribe(() => this.pull())
    this.pull()
  }

  dispose(): void {
    this.unsub?.()
    this.listeners.clear()
    for (const unsub of this.probeUnsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.probeUnsubs.clear()
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot(): SearxngSnapshot {
    return this.snapshot
  }

  private pull(): void {
    const s = this.scope.getSnapshot() as unknown as {
      status: string
      value?: SearxngConfig
      revision?: number
      writable: boolean
      error?: string
    }
    this.snapshot = {
      status: (s.status as SearxngSnapshot['status']) ?? 'loading',
      value: s.value,
      revision: s.revision,
      writable: s.writable,
      ...(s.error ? { error: s.error } : {}),
    }
    this.emit()
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /** Persist the staged form as one field write per key. */
  async save(next: SearxngConfig): Promise<void> {
    for (const key of SEARXNG_FIELD_KEYS) {
      await this.scope.set(key, next[key])
    }
  }

  /**
   * Run one probe round through the `searxng-probe` settings section: write
   * the request (requestId LAST), wait for the host's matching result.
   *
   * The probe scope binds lazily so a host that predates the section fails
   * here with `probe-unsupported` instead of killing the card. A host that
   * never answers (also: old host) trips `probe-timeout`. Per-target
   * failures are normal outcomes (`ok: false`), never thrown.
   */
  async probeBatch(
    targets: ProbeTarget[],
    opts?: { proxyUrl?: string; timeoutMs?: number },
  ): Promise<ProbeTargetResult[]> {
    const scope = this.ensureProbeScope()
    const list = targets.slice(0, PROBE_MAX_TARGETS)
    if (list.length === 0) return []
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try {
      await scope.set('targetsJson', JSON.stringify(list))
      await scope.set('proxyUrl', opts?.proxyUrl ?? '')
      await scope.set('timeoutMs', opts?.timeoutMs ?? 12_000)
      await scope.set('error', '')
      await scope.set('requestId', requestId)
    } catch {
      throw new Error('probe-unsupported')
    }
    return new Promise<ProbeTargetResult[]>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.probeUnsubs.delete(unsub)
        try {
          unsub()
        } catch {
          /* ignore */
        }
        fn()
      }
      const timer = setTimeout(() => {
        done(() => reject(new Error('probe-timeout')))
      }, PROBE_ROUND_TIMEOUT_MS)
      const check = (): void => {
        let snap: unknown
        try {
          snap = scope.getSnapshot()
        } catch {
          return
        }
        const value = (snap as { value?: Record<string, unknown> })?.value
        if (!value || value.resultId !== requestId) return
        if (typeof value.error === 'string' && value.error) {
          const msg = value.error
          done(() => reject(new Error(`probe-round: ${msg}`)))
          return
        }
        if (typeof value.resultsJson !== 'string') return
        let results: unknown
        try {
          results = JSON.parse(value.resultsJson)
        } catch {
          done(() => reject(new Error('probe-round: malformed results')))
          return
        }
        if (!Array.isArray(results)) {
          done(() => reject(new Error('probe-round: malformed results')))
          return
        }
        const parsed = results as ProbeTargetResult[]
        done(() => resolve(parsed))
      }
      const unsub = scope.subscribe(check)
      this.probeUnsubs.add(unsub)
      check()
    })
  }

  private ensureProbeScope(): any {
    if (this.probeScope) return this.probeScope
    if (this.probeScopeFailed || !this.settingsScope || typeof this.settingsScope.bind !== 'function') {
      throw new Error('probe-unsupported')
    }
    try {
      this.probeScope = this.settingsScope.bind({ namespace: PROBE_NS })
      return this.probeScope
    } catch {
      this.probeScopeFailed = true
      throw new Error('probe-unsupported')
    }
  }

  private instancesScope?: any
  private instancesScopeFailed = false

  private ensureInstancesScope(): any {
    if (this.instancesScope) return this.instancesScope
    if (this.instancesScopeFailed || !this.settingsScope || typeof this.settingsScope.bind !== 'function') {
      throw new Error('refresh-unsupported')
    }
    try {
      this.instancesScope = this.settingsScope.bind({ namespace: INSTANCES_NS })
      return this.instancesScope
    } catch {
      this.instancesScopeFailed = true
      throw new Error('refresh-unsupported')
    }
  }

  private readInstancesValue(): Record<string, unknown> | undefined {
    let snap: unknown
    try {
      snap = this.ensureInstancesScope().getSnapshot()
    } catch {
      return undefined
    }
    const value = (snap as { value?: Record<string, unknown> })?.value
    return value && typeof value === 'object' ? value : undefined
  }

  /** Read the cached community list without requesting a refresh (mount path). */
  readInstancesCache(): InstancesCache | undefined {
    const value = this.readInstancesValue()
    if (!value || typeof value.instancesJson !== 'string' || typeof value.fetchedAt !== 'string') {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value.instancesJson)
    } catch {
      return undefined
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !value.fetchedAt) return undefined
    return { instances: parsed as RefreshedInstance[], fetchedAt: value.fetchedAt }
  }

  /**
   * Refresh the community list through the `searxng-instances` section:
   * write the request (refreshRequestId LAST), wait for the host fetch.
   * Old-host failures surface as `refresh-unsupported` / `refresh-timeout`;
   * a failed fetch surfaces as `refresh: <reason>` and leaves the old
   * cache (and the bundled snapshot) untouched.
   */
  async refreshInstances(opts?: { proxyUrl?: string }): Promise<InstancesCache> {
    const scope = this.ensureInstancesScope()
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try {
      await scope.set('proxyUrl', opts?.proxyUrl ?? '')
      await scope.set('refreshError', '')
      await scope.set('refreshRequestId', requestId)
    } catch {
      throw new Error('refresh-unsupported')
    }
    return new Promise<InstancesCache>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.probeUnsubs.delete(unsub)
        try {
          unsub()
        } catch {
          /* ignore */
        }
        fn()
      }
      const timer = setTimeout(() => {
        done(() => reject(new Error('refresh-timeout')))
      }, INSTANCES_REFRESH_TIMEOUT_MS)
      const check = (): void => {
        const value = this.readInstancesValue()
        if (!value || value.refreshResultId !== requestId) return
        if (typeof value.refreshError === 'string' && value.refreshError) {
          const msg = value.refreshError
          done(() => reject(new Error(`refresh: ${msg}`)))
          return
        }
        if (typeof value.instancesJson !== 'string' || typeof value.fetchedAt !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(value.instancesJson)
        } catch {
          done(() => reject(new Error('refresh: malformed list')))
          return
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          done(() => reject(new Error('refresh: empty list')))
          return
        }
        const cache: InstancesCache = {
          instances: parsed as RefreshedInstance[],
          fetchedAt: value.fetchedAt,
        }
        done(() => resolve(cache))
      }
      const unsub = scope.subscribe(check)
      this.probeUnsubs.add(unsub)
      check()
    })
  }
}
