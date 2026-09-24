import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { SearxngController, SearxngConfig, ProbeTarget, ProbeTargetResult, InstancesCache } from './controller.js'
import { normalizeConfig, validateConfig } from './controller.js'
import { getSnapshot as getInstanceSnapshot, snapshotLabel, instanceMeta } from './instances.js'
import { en } from './locales.js'

/**
 * Short human-readable probe failure. Known host codes map to locale copy;
 * anything else is the raw provider error, truncated.
 */
function probeDisplay(t: (k: keyof typeof en) => string, err: string | undefined): string {
  if (!err) return ''
  if (err === 'invalid-url') return t('invalidURL')
  if (err === 'invalid-proxy') return t('invalidProxy')
  if (/HTTP 403/.test(err)) return t('probeReason403')
  if (/HTTP 429/.test(err)) return t('probeReason429')
  if (/abort/i.test(err) || /timeout/i.test(err)) return t('probeReasonTimeout')
  return err.length > 140 ? `${err.slice(0, 140)}…` : err
}

/** Failure severity for ranking failed rows: transient (retryable) floats up. */
function failSeverityOfResult(error: string | undefined): 'transient' | 'persistent' {
  if (!error) return 'persistent'
  // 429 rate limit, probe timeout/abort, flaky gateways — worth retrying.
  if (/429/.test(error)) return 'transient'
  if (/abort/i.test(error) || /timeout/i.test(error)) return 'transient'
  if (/HTTP 50[234]/.test(error)) return 'transient'
  // 403 (JSON disabled), bad URL/proxy, dead hosts stay at the bottom.
  return 'persistent'
}

/** Severity for transport-level chunk failures (no per-target result). */
function failSeverityOfMessage(message: string): 'transient' | 'persistent' {
  if (/timeout/.test(message)) return 'transient'
  return 'persistent'
}

/** Map a thrown refresh error to display copy (mirrors probeNote). */
function refreshNote(t: (k: keyof typeof en) => string, message: string): string {
  if (message.startsWith('refresh-unsupported')) return t('probeUnsupported')
  if (message.startsWith('refresh-timeout')) return t('probeTimeout')
  return probeDisplay(t, message.replace(/^refresh:\s*/, ''))
}

/** Map a thrown probe error (transport-level) to display copy. */
function probeNote(t: (k: keyof typeof en) => string, message: string): string {
  if (message.startsWith('probe-unsupported')) return t('probeUnsupported')
  if (message.startsWith('probe-timeout')) return t('probeTimeout')
  return probeDisplay(t, message.replace(/^probe-round:\s*/, ''))
}

type ManualProbe =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; result: ProbeTargetResult }
  | { status: 'fail'; result?: ProbeTargetResult; note: string }

// ---------------------------------------------------------------------------
// Token-based styling mirroring ui-settings-models / ui-settings-plugins so
// the card feels native in both themes. Single <style> tag keyed by plugin
// id (idempotent across HMR).
// ---------------------------------------------------------------------------
const SX_CSS = `
.sx_input,.sx_select{
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);
  border-radius:8px;
  height:32px;
  font:inherit;
  font-size:13px;
  line-height:1.5;
  padding:0 10px;
  width:100%;
}
.sx_select{
  appearance:none;
  cursor:pointer;
  padding-right:32px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position:right 10px center;
  background-repeat:no-repeat;
  background-size:12px 12px;
}
.sx_input:focus,.sx_select:focus{
  border-color:var(--dsw-alias-brand-primary);
  outline:none;
}
.sx_input:disabled,.sx_select:disabled{
  opacity:.6;
  cursor:default;
}
.sx_input::placeholder{
  color:var(--dsw-alias-label-dimmed);
}
.sx_inputInvalid{
  border-color:var(--dsw-alias-label-error) !important;
}
.sx_btnPrimary{
  box-sizing:border-box;
  height:32px;
  padding:0 14px;
  border-radius:8px;
  border:1px solid transparent;
  background:var(--dsw-alias-label-primary);
  color:var(--dsw-alias-bg-layer-3);
  font:inherit;
  font-size:13px;
  line-height:1.5;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
}
.sx_btnPrimary:disabled{opacity:.4;cursor:default;}
.sx_btnPrimary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.sx_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-3);}
.sx_field{display:flex;flex-direction:column;gap:4px;}
.sx_label{font-size:12px;color:var(--dsw-alias-label-dimmed);}
.sx_error{font-size:12px;color:var(--dsw-alias-label-error);}
.sx_hint{font-size:12px;color:var(--dsw-alias-label-dimmed);}
.sx_row{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.sx_footer{display:flex;align-items:center;gap:8px;}
.sx_msg{font-size:12px;color:var(--dsw-alias-label-dimmed);}
.sx_btnSecondary{
  box-sizing:border-box;
  height:28px;
  padding:0 10px;
  border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);
  font:inherit;
  font-size:12px;
  line-height:1.5;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:4px;
}
.sx_btnSecondary:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover);
  border-color:var(--dsw-alias-label-dimmed);
}
.sx_btnSecondary:disabled{opacity:.4;cursor:default;}
.sx_picker{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;}
.sx_pickRow{display:flex;align-items:center;gap:8px;}
.sx_pickUrl{font-size:12px;word-break:break-all;flex:1;}
.sx_pickMeta{font-size:11px;color:var(--dsw-alias-label-dimmed);}
`
const SX_CSS_TAG_ID = 'dsh-web-searxng/card.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${SX_CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-web-searxng'
  tag.dataset.pluginCss = SX_CSS_TAG_ID
  tag.textContent = SX_CSS
  document.head.appendChild(tag)
}

type Props = {
  controller: SearxngController
  t?: (k: keyof typeof en) => string
}

const labelStyle: CSSProperties = { fontSize: 12 }
const descStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }

export function SearxngCard({ controller, t: tProp }: Props) {
  const t = tProp ?? ((k: keyof typeof en) => en[k])
  const snap = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  )

  // Pre-switch settings docs lack proxyEnabled: normalize keeps the proxy active.
  const cfg: SearxngConfig = useMemo(() => normalizeConfig(snap.value), [snap.value])

  const [draft, setDraft] = useState<SearxngConfig>(cfg)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | undefined>()
  const [pickerOpen, setPickerOpen] = useState(() => cfg.baseURL === '')
  const [manualProbe, setManualProbe] = useState<ManualProbe>({ status: 'idle' })

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg), [draft, cfg])

  // Sync remote → draft only while the user has NO local edits, so the
  // intermediate snapshots of a save's field writes never clobber editing.
  useEffect(() => {
    if (!dirty) setDraft(cfg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])

  useEffect(() => {
    if (!msg || msg !== t('saved')) return
    const timer = setTimeout(() => setMsg(undefined), 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg])

  const errors = useMemo(() => validateConfig(draft), [draft])
  const hasError = Object.keys(errors).length > 0
  const disabled = saving || !snap.writable || snap.status !== 'ready'

  const set = (key: keyof SearxngConfig) => (e: { target: { value: string } }) => {
    const v = e.target.value
    setDraft((d) => ({ ...d, [key]: key === 'safesearch' ? Number(v) : v }))
  }

  const setBool = (key: 'proxyEnabled') => (e: { target: { checked: boolean } }) => {
    setDraft((d) => ({ ...d, [key]: e.target.checked }))
  }

  // A disabled proxy stays in the draft as inert text: test, picker and
  // refresh below all run direct while the URL is kept.
  const effectiveProxy = draft.proxyEnabled === false ? '' : draft.proxyUrl.trim()

  const onSave = async () => {
    if (hasError || !snap.writable) return
    setSaving(true)
    setMsg(undefined)
    try {
      await controller.save(draft)
      setMsg(t('saved'))
    } catch (err) {
      setMsg(`${t('saveFailed')}${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  // Manual probe of the staged draft (baseURL + auth + proxy as typed).
  // Guarded against double-clicks; a finished probe never throws for
  // instance-side failures — those arrive as `{ ok: false }`.
  const onTestConnection = async () => {
    if (disabled || manualProbe.status === 'testing') return
    const baseURL = draft.baseURL.trim()
    if (!baseURL || errors.baseURL) return
    setManualProbe({ status: 'testing' })
    const target: ProbeTarget = {
      url: baseURL,
      ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
      ...(draft.password ? { password: draft.password } : {}),
      categories: draft.categories || 'general',
      language: draft.language || 'zh-CN',
      safesearch: draft.safesearch,
    }
    const proxy = effectiveProxy
    try {
      const results = await controller.probeBatch([target], { ...(proxy ? { proxyUrl: proxy } : {}) })
      const result = results[0]
      if (!result) {
        setManualProbe({ status: 'fail', note: probeNote(t, 'probe-round: empty result') })
        return
      }
      setManualProbe(result.ok ? { status: 'ok', result } : { status: 'fail', result, note: probeDisplay(t, result.error) })
    } catch (err) {
      setManualProbe({ status: 'fail', note: probeNote(t, err instanceof Error ? err.message : String(err)) })
    }
  }

  const onPickInstance = (url: string) => {
    setDraft((d) => ({ ...d, baseURL: url }))
    setManualProbe({ status: 'idle' })
  }

  if (snap.status === 'loading') {
    return <div className="sx_card"><span className="sx_hint">{t('reading')}</span></div>
  }
  if (snap.status !== 'ready') {
    return (
      <div className="sx_card">
        <span className="sx_error">{t('unavailable')}</span>
      </div>
    )
  }

  return (
    <div className="sx_card">
      <div>
        <div style={labelStyle}><strong>{t('title')}</strong></div>
        <div style={descStyle}>{t('desc')}</div>
        <div className="sx_hint">{t('pinHint')}</div>
      </div>

      {!snap.writable && <div className="sx_hint">{t('readOnly')}</div>}
      {cfg.baseURL === '' && !dirty && <div className="sx_hint">{t('unconfigured')}</div>}

      <div>
        <button
          className="sx_btnSecondary"
          onClick={() => setPickerOpen((v) => !v)}
          disabled={disabled}
          title={!snap.writable ? t('readOnly') : undefined}
        >
          {t('communityToggle')}
        </button>
      </div>
      {pickerOpen && (
        <CommunityPicker
          t={t}
          disabled={disabled}
          controller={controller}
          proxyUrl={effectiveProxy}
          onPick={onPickInstance}
        />
      )}

      <div className="sx_field">
        <label className="sx_label">{t('baseURL')}</label>
        <input
          className={'sx_input' + (errors.baseURL ? ' sx_inputInvalid' : '')}
          value={draft.baseURL}
          placeholder={t('baseURLPlaceholder')}
          onChange={set('baseURL')}
          disabled={disabled}
          inputMode="url"
        />
        {errors.baseURL && <span className="sx_error">{t('invalidURL')}</span>}
        <div className="sx_footer">
          <button
            className="sx_btnSecondary"
            onClick={onTestConnection}
            disabled={disabled || manualProbe.status === 'testing' || !draft.baseURL.trim() || !!errors.baseURL}
          >
            {manualProbe.status === 'testing' ? t('testing') : t('testConnection')}
          </button>
          {manualProbe.status === 'ok' && manualProbe.result && (
            <span
              className="sx_msg"
              title={manualProbe.result.firstUrl ?? manualProbe.result.firstTitle ?? ''}
            >
              {`● ${t('probeOk').replace('{ms}', `${manualProbe.result.latencyMs}ms`).replace('{count}', String(manualProbe.result.resultCount))}`}
              {manualProbe.result.firstTitle ? ` · ${t('probeFirst').replace('{title}', manualProbe.result.firstTitle)}` : ''}
            </span>
          )}
          {manualProbe.status === 'fail' && (
            <span className="sx_error" title={manualProbe.result?.error ?? manualProbe.note}>
              {`✕ ${manualProbe.note}`}
            </span>
          )}
        </div>
      </div>

      <div className="sx_row">
        <div className="sx_field">
          <label className="sx_label">{t('username')}</label>
          <input
            className="sx_input"
            value={draft.username}
            placeholder={t('usernamePlaceholder')}
            onChange={set('username')}
            disabled={disabled}
            autoComplete="off"
          />
        </div>
        <div className="sx_field">
          <label className="sx_label">{t('password')}</label>
          <input
            className="sx_input"
            type="password"
            value={draft.password}
            placeholder={t('passwordPlaceholder')}
            onChange={set('password')}
            disabled={disabled}
            autoComplete="new-password"
          />
        </div>
      </div>
      <div className="sx_hint">{t('passwordNote')}</div>

      <div className="sx_row">
        <div className="sx_field">
          <label className="sx_label">{t('categories')}</label>
          <input
            className="sx_input"
            value={draft.categories}
            placeholder={t('categoriesPlaceholder')}
            onChange={set('categories')}
            disabled={disabled}
          />
        </div>
        <div className="sx_field">
          <label className="sx_label">{t('language')}</label>
          <input
            className="sx_input"
            value={draft.language}
            placeholder={t('languagePlaceholder')}
            onChange={set('language')}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="sx_field">
        <label className="sx_label">{t('safesearch')}</label>
        <select
          className="sx_select"
          value={String(draft.safesearch)}
          onChange={set('safesearch')}
          disabled={disabled}
        >
          <option value="0">{t('safesearchOff')}</option>
          <option value="1">{t('safesearchModerate')}</option>
          <option value="2">{t('safesearchStrict')}</option>
        </select>
      </div>

      <div className="sx_field">
        <label className="sx_label" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.proxyEnabled !== false}
            onChange={setBool('proxyEnabled')}
            disabled={disabled}
          />
          {t('proxyEnabled')}
        </label>
        <label className="sx_label">{t('proxyUrl')}</label>
        <input
          className={'sx_input' + (errors.proxyUrl ? ' sx_inputInvalid' : '')}
          value={draft.proxyUrl}
          placeholder={t('proxyUrlPlaceholder')}
          onChange={set('proxyUrl')}
          disabled={disabled || draft.proxyEnabled === false}
          autoComplete="off"
        />
        {errors.proxyUrl && <span className="sx_error">{t('invalidProxy')}</span>}
        <span className="sx_hint">{draft.proxyEnabled === false ? t('proxyDisabledNote') : t('proxyUrlNote')}</span>
      </div>

      <div className="sx_footer">
        <button className="sx_btnPrimary" onClick={onSave} disabled={disabled || !dirty || hasError}>
          {saving ? t('saving') : t('save')}
        </button>
        {msg && <span className="sx_msg">{msg}</span>}
      </div>
    </div>
  )
}

/**
 * Community instance picker over the bundled searx.space snapshot.
 * Picking only stages the URL into the draft — the user still saves.
 *
 * On open, every listed instance is silently probed through the host in ONE
 * settings round-trip (one real search each, current draft proxy, no auth)
 * and rows are ranked reachable-first by latency; failures stay selectable
 * but dimmed with their reason. Results are cached per URL+proxy for the
 * page lifetime — `retest` clears the cache and probes again. A positive
 * probe also verifies `?format=json`, which the checker metadata never
 * records.
 */
type RowProbe =
  | { status: 'testing' }
  | { status: 'ok'; result: ProbeTargetResult }
  | { status: 'fail'; note: string; severity: 'transient' | 'persistent' }

/** Page-lifetime probe cache (URL + proxy ⇒ outcome). Survives picker reopen. */
const rowProbeCache = new Map<string, RowProbe>()
const rowProbeKey = (url: string, proxy: string): string => `${url}\n${proxy}`
/** Stop auto-probing once this many rows are usable (rest stay queued). */
const TARGET_USABLE = 10

/** Date line prefers the refreshed cache; stale flag follows the active source. */
function activeDateLabel(
  t: (k: keyof typeof en) => string,
  bundledLabel: string | null,
  fetchedAt: string | undefined,
): string {
  if (fetchedAt) {
    const d = new Date(Date.parse(fetchedAt))
    if (!Number.isNaN(d.getTime())) return t('communityFresh').replace('{date}', d.toLocaleDateString())
  }
  return bundledLabel ? t('communityFresh').replace('{date}', bundledLabel) : t('communityEmptyShort')
}

function isActiveStale(bundledAt: string | null, fetchedAt: string | undefined): boolean {
  const src = fetchedAt ?? bundledAt ?? undefined
  if (!src) return true
  const v = Date.parse(src)
  return Number.isNaN(v) || Date.now() - v > 30 * 24 * 3600 * 1000
}

function CommunityPicker(props: {
  t: (k: keyof typeof en) => string
  disabled: boolean
  controller: SearxngController
  proxyUrl: string
  onPick: (url: string) => void
}) {
  const { t, disabled, controller, proxyUrl, onPick } = props
  const snap = getInstanceSnapshot()
  const label = snapshotLabel()
  const [tick, setTick] = useState(0)
  const [round, setRound] = useState(0)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [remote, setRemote] = useState<InstancesCache | null>(null)
  const [refresh, setRefresh] = useState<{ status: 'idle' | 'working' | 'fail'; note?: string }>({ status: 'idle' })
  const [onlyUsable, setOnlyUsable] = useState(true)
  const bump = () => setTick((n) => n + 1)
  // Runtime cache (one-click refresh) wins when newer than the bundle.
  const list = remote?.instances ?? snap.instances
  const urlsKey = list.map((i) => i.url).join('\n')

  // Adopt the cached list on open when it is fresher than the bundle.
  useEffect(() => {
    const cache = controller.readInstancesCache()
    if (!cache) return
    const ft = Date.parse(cache.fetchedAt)
    if (Number.isNaN(ft)) return
    const bt = snap.updatedAt ? Date.parse(snap.updatedAt) : NaN
    if (!snap.updatedAt || Number.isNaN(bt) || ft > bt) setRemote(cache)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Silent auto-probe on open / proxy change / retest: sequential batch
  // chunks (≤12 targets each) for every uncached row. Unmount-safe via a
  // generation flag (late results still land in the page-lifetime cache).
  // Silent auto-probe on open / proxy change / retest / refresh: sequential
  // batch chunks (≤12 targets each) over uncached rows, in list order.
  // Early stop: once TARGET_USABLE rows are usable, the rest stay queued
  // (never marked testing, so no row pretends to be in flight). Unmount-safe
  // via a generation flag (late results still land in the page cache).
  useEffect(() => {
    let cancelled = false
    const usableCount = (): number => {
      let n = 0
      for (const i of list) {
        if (rowProbeCache.get(rowProbeKey(i.url, proxyUrl))?.status === 'ok') n++
      }
      return n
    }
    const pending = list.filter((i) => !rowProbeCache.has(rowProbeKey(i.url, proxyUrl)))
    if (pending.length === 0 || usableCount() >= TARGET_USABLE) return () => {}
    setProgress({ done: 0, total: pending.length })
    bump()
    const applyResults = (targets: { url: string }[], results: ProbeTargetResult[]): void => {
      const byUrl = new Map(results.map((r) => [r.url, r]))
      for (const item of targets) {
        const key = rowProbeKey(item.url, proxyUrl)
        const result = byUrl.get(item.url)
        if (!result) {
          rowProbeCache.set(key, {
            status: 'fail',
            note: probeNote(t, 'probe-round: missing result'),
            severity: 'persistent',
          })
        } else if (result.ok) {
          rowProbeCache.set(key, { status: 'ok', result })
        } else {
          rowProbeCache.set(key, {
            status: 'fail',
            note: probeDisplay(t, result.error),
            severity: failSeverityOfResult(result.error),
          })
        }
      }
    }
    const markFailed = (targets: { url: string }[], note: string, severity: 'transient' | 'persistent'): void => {
      for (const t of targets) rowProbeCache.set(rowProbeKey(t.url, proxyUrl), { status: 'fail', note, severity })
    }
    // Sequential chunks of ≤12 (the round cap): rows resolve progressively
    // and the ranking re-flows as each chunk lands. Stops early once
    // TARGET_USABLE rows are usable; the progress line then clears.
    const run = async (): Promise<void> => {
      const CHUNK = 12
      let done = 0
      for (let k = 0; k * CHUNK < pending.length && !cancelled; k++) {
        if (usableCount() >= TARGET_USABLE) break
        const slice = pending.slice(k * CHUNK, (k + 1) * CHUNK)
        for (const i of slice) rowProbeCache.set(rowProbeKey(i.url, proxyUrl), { status: 'testing' })
        bump()
        try {
          const results = await controller.probeBatch(
            slice.map((i) => ({ url: i.url })),
            { ...(proxyUrl ? { proxyUrl } : {}) },
          )
          applyResults(slice, results)
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err)
          markFailed(slice, probeNote(t, raw), failSeverityOfMessage(raw))
        }
        done += slice.length
        if (!cancelled) {
          setProgress({ done, total: pending.length })
          bump()
        }
      }
      // Clear the progress line on early stop (else "measured x/100" lingers).
      if (!cancelled) setProgress({ done, total: done })
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey, proxyUrl, round])

  const retest = () => {
    for (const i of list) rowProbeCache.delete(rowProbeKey(i.url, proxyUrl))
    setRound((n) => n + 1)
  }

  // One-click refresh: host fetches searx.space and caches the curated list.
  // New rows auto-probe via the round bump; same-URL rows keep their status.
  const doRefresh = () => {
    if (refresh.status === 'working') return
    setRefresh({ status: 'working' })
    void controller
      .refreshInstances({ ...(proxyUrl ? { proxyUrl } : {}) })
      .then(
        (cache) => {
          setRemote(cache)
          setRefresh({ status: 'idle' })
          setRound((n) => n + 1)
        },
        (err) => {
          setRefresh({
            status: 'fail',
            note: refreshNote(t, err instanceof Error ? err.message : String(err)),
          })
        },
      )
  }

  const ranked = useMemo(() => {
    // ok 0 · testing 1 · queued (never probed, e.g. after early stop) 2 · fail 3.
    const rankOf = (url: string): number => {
      const p = rowProbeCache.get(rowProbeKey(url, proxyUrl))
      if (!p) return 2
      if (p.status === 'testing') return 1
      return p.status === 'ok' ? 0 : 3
    }
    return [...list].sort((a, b) => {
      const ra = rankOf(a.url)
      const rb = rankOf(b.url)
      if (ra !== rb) return ra - rb
      if (ra === 0) {
        const pa = rowProbeCache.get(rowProbeKey(a.url, proxyUrl))
        const pb = rowProbeCache.get(rowProbeKey(b.url, proxyUrl))
        const la = pa?.status === 'ok' ? pa.result.latencyMs : Number.MAX_SAFE_INTEGER
        const lb = pb?.status === 'ok' ? pb.result.latencyMs : Number.MAX_SAFE_INTEGER
        if (la !== lb) return la - lb
      }
      // Failed rows: transient (429 / timeout / flaky gateway) above
      // persistent (403 JSON-disabled, bad URL, dead host).
      if (ra === 3) {
        const pa = rowProbeCache.get(rowProbeKey(a.url, proxyUrl))
        const pb = rowProbeCache.get(rowProbeKey(b.url, proxyUrl))
        const sa = pa?.status === 'fail' && pa.severity === 'transient' ? 0 : 1
        const sb = pb?.status === 'fail' && pb.severity === 'transient' ? 0 : 1
        if (sa !== sb) return sa - sb
      }
      return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER)
    })
    // `tick` re-runs the sort as silent probes settle (cache itself is not reactive).
  }, [snap, remote, proxyUrl, round, tick])

  const rowStatus = (url: string): { mark: string; text: string; failed: boolean } => {
    const p = rowProbeCache.get(rowProbeKey(url, proxyUrl))
    if (!p) return { mark: '○', text: t('probeQueued'), failed: false }
    if (p.status === 'testing') return { mark: '○', text: t('probeRowTesting'), failed: false }
    if (p.status === 'ok') {
      return {
        mark: '●',
        text: t('probeOk')
          .replace('{ms}', `${p.result.latencyMs}ms`)
          .replace('{count}', String(p.result.resultCount)),
        failed: false,
      }
    }
    return { mark: '✕', text: p.note, failed: true }
  }

  // "Only usable" (default): rows appear as they pass probing; uncheck to
  // inspect rows that were probed but failed (with reasons).
  const displayed = onlyUsable
    ? ranked.filter((i) => rowProbeCache.get(rowProbeKey(i.url, proxyUrl))?.status === 'ok')
    : ranked
  const anyPending = list.some((i) => {
    const p = rowProbeCache.get(rowProbeKey(i.url, proxyUrl))
    return !p || p.status === 'testing'
  })

  return (
    <div className="sx_picker">
      <div className="sx_hint">{t('communityDesc')}</div>
      <div className="sx_hint">{t('probeAutoNote')}</div>
      <label className="sx_hint" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={onlyUsable}
          disabled={disabled}
          onChange={(e) => setOnlyUsable(e.target.checked)}
        />
        {t('onlyUsable')}
      </label>
      {progress.total > 0 && progress.done < progress.total && (
        <div className="sx_hint">{t('probeProgress').replace('{done}', String(progress.done)).replace('{total}', String(progress.total))}</div>
      )}
      {list.length === 0 && (
        <div className="sx_hint">{t('communityEmpty')}</div>
      )}
      {list.length > 0 && displayed.length === 0 && !anyPending && (
        <div className="sx_hint">{t('noUsable')}</div>
      )}
      {displayed.map((i) => {
        const st = rowStatus(i.url)
        return (
          <div className="sx_pickRow" key={i.url} style={st.failed ? { opacity: 0.75 } : undefined}>
            <div style={{ flex: 1 }}>
              <div className="sx_pickUrl">{`${st.mark} ${i.url}`}</div>
              <div className="sx_pickMeta">{instanceMeta(i)}</div>
              <div className={st.failed ? 'sx_error' : 'sx_pickMeta'}>{st.text}</div>
            </div>
            <button
              className="sx_btnSecondary"
              onClick={() => onPick(i.url)}
              disabled={disabled}
            >
              {t('communityUse')}
            </button>
          </div>
        )
      })}
      <div className="sx_footer">
        <button className="sx_btnSecondary" onClick={retest}>
          {t('retest')}
        </button>
        <button
          className="sx_btnSecondary"
          onClick={doRefresh}
          disabled={disabled || refresh.status === 'working'}
        >
          {refresh.status === 'working' ? t('refreshing') : t('refreshList')}
        </button>
      </div>
      {refresh.status === 'fail' && refresh.note && (
        <div className="sx_error">{refresh.note}</div>
      )}
      <div className="sx_hint">
        {activeDateLabel(t, label, remote?.fetchedAt)}
        {isActiveStale(snap.updatedAt, remote?.fetchedAt) && list.length > 0 ? ` ${t('communityStale')}` : ''}
        {` ${t('communityJsonNote')}`}
      </div>
    </div>
  )
}
