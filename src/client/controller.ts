/** SearXNG settings card controller. */
export type ConfigFormScope = {
  getSnapshot(): any
  subscribe(cb: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

export type SearxngConfig = {
  baseURL: string
  username: string
  password: string
  categories: string
  language: string
  safesearch: number
  proxyUrl: string
  /** false keeps proxyUrl but disables use. */
  proxyEnabled: boolean
}

export const SEARXNG_FIELD_KEYS = [
  'baseURL',
  'username',
  'password',
  'categories',
  'language',
  'safesearch',
  'proxyUrl',
  'proxyEnabled',
] as const

export type SearxngSnapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  value?: SearxngConfig
  revision?: number
  writable: boolean
}

/** Client copies of host probe types. */
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

/** Maximum targets per round. */
export const PROBE_MAX_TARGETS = 12
/** Probe response timeout. */
export const PROBE_ROUND_TIMEOUT_MS = 50_000
/** Instance refresh timeout. */
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
    proxyEnabled: true,
  }
}

/** Merge settings over defaults. */
export function normalizeConfig(value: Partial<SearxngConfig> | undefined): SearxngConfig {
  return { ...defaultConfig(), ...value, proxyEnabled: value?.proxyEnabled ?? true }
}

/** Validate before saving. */
export function validateConfig(cfg: SearxngConfig): Partial<Record<keyof SearxngConfig, string>> {
  const errors: Partial<Record<keyof SearxngConfig, string>> = {}
  if (cfg.baseURL !== '' && !canParseUrl(cfg.baseURL)) errors.baseURL = 'invalid-url'
  if (![0, 1, 2].includes(cfg.safesearch)) errors.safesearch = 'invalid-range'
  // Disabled proxies are not dialed.
  if (cfg.proxyEnabled !== false && cfg.proxyUrl !== '' && !isValidProxy(cfg.proxyUrl)) {
    errors.proxyUrl = 'invalid-proxy'
  }
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

function freshRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class SearxngController {
  private listeners = new Set<Listener>()
  private snapshot: SearxngSnapshot = { status: 'loading', writable: false }
  private unsub?: () => void
  private roundUnsubs = new Set<() => void>()

  constructor(private readonly scope: ConfigFormScope) {}

  bind(): void {
    this.unsub = this.scope.subscribe(() => this.pull())
    this.pull()
  }

  dispose(): void {
    this.unsub?.()
    this.listeners.clear()
    for (const unsub of this.roundUnsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.roundUnsubs.clear()
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
    }
    this.snapshot = {
      status: (s.status as SearxngSnapshot['status']) ?? 'loading',
      value: s.value,
      revision: s.revision,
      writable: s.writable,
    }
    this.emit()
  }

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /** Persist each field; stop on refusal. */
  async save(next: SearxngConfig): Promise<void> {
    for (const key of SEARXNG_FIELD_KEYS) {
      if (!(await this.scope.set(key, next[key]))) throw new Error(`save-refused: ${key}`)
    }
  }

  /** Read one protocol field. */
  private fieldValue(key: string): unknown {
    const snap = this.scope.getSnapshot() as unknown as { value?: Record<string, unknown> }
    return snap?.value?.[key]
  }

  /** Probe a batch through the shared form. */
  async probeBatch(
    targets: ProbeTarget[],
    opts?: { proxyUrl?: string; timeoutMs?: number },
  ): Promise<ProbeTargetResult[]> {
    const list = targets.slice(0, PROBE_MAX_TARGETS)
    if (list.length === 0) return []
    const requestId = freshRequestId()
    if (
      !(await this.scope.set('probeTargetsJson', JSON.stringify(list))) ||
      !(await this.scope.set('probeProxyUrl', opts?.proxyUrl ?? '')) ||
      !(await this.scope.set('probeTimeoutMs', opts?.timeoutMs ?? 12_000)) ||
      !(await this.scope.set('probeError', '')) ||
      !(await this.scope.set('probeRequestId', requestId))
    ) {
      throw new Error('probe-unsupported')
    }
    return new Promise<ProbeTargetResult[]>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.roundUnsubs.delete(unsub)
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
        if (this.fieldValue('probeResultId') !== requestId) return
        const roundError = this.fieldValue('probeError')
        if (typeof roundError === 'string' && roundError) {
          done(() => reject(new Error(`probe-round: ${roundError}`)))
          return
        }
        const raw = this.fieldValue('probeResultsJson')
        if (typeof raw !== 'string') return
        let results: unknown
        try {
          results = JSON.parse(raw)
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
      const unsub = this.scope.subscribe(check)
      this.roundUnsubs.add(unsub)
      check()
    })
  }

  /** Read the cached instance list. */
  readInstancesCache(): InstancesCache | undefined {
    const instancesJson = this.fieldValue('instancesJson')
    const fetchedAt = this.fieldValue('instancesFetchedAt')
    if (typeof instancesJson !== 'string' || typeof fetchedAt !== 'string' || !fetchedAt) {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(instancesJson)
    } catch {
      return undefined
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return { instances: parsed as RefreshedInstance[], fetchedAt }
  }

  /** Refresh instances through the shared form. */
  async refreshInstances(opts?: { proxyUrl?: string }): Promise<InstancesCache> {
    const requestId = freshRequestId()
    if (
      !(await this.scope.set('instancesProxyUrl', opts?.proxyUrl ?? '')) ||
      !(await this.scope.set('refreshError', '')) ||
      !(await this.scope.set('refreshRequestId', requestId))
    ) {
      throw new Error('refresh-unsupported')
    }
    return new Promise<InstancesCache>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.roundUnsubs.delete(unsub)
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
        if (this.fieldValue('refreshResultId') !== requestId) return
        const roundError = this.fieldValue('refreshError')
        if (typeof roundError === 'string' && roundError) {
          done(() => reject(new Error(`refresh: ${roundError}`)))
          return
        }
        const instancesJson = this.fieldValue('instancesJson')
        const fetchedAt = this.fieldValue('instancesFetchedAt')
        if (typeof instancesJson !== 'string' || typeof fetchedAt !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(instancesJson)
        } catch {
          done(() => reject(new Error('refresh: malformed list')))
          return
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          done(() => reject(new Error('refresh: empty list')))
          return
        }
        done(() => resolve({ instances: parsed as RefreshedInstance[], fetchedAt }))
      }
      const unsub = this.scope.subscribe(check)
      this.roundUnsubs.add(unsub)
      check()
    })
  }
}
