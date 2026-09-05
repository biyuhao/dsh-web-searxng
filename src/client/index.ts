/**
 * Browser half: registers the `settings.plugin.item` card for `searxng`.
 * Non-invasive: only depends on the declared slot via type-only import.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SearxngCard } from './SearxngCard.js'
import { SearxngController } from './controller.js'
import { en, zh } from './locales.js'

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register('settings.searxng' as never, { en, zh } as never),
    'searxng: locale',
  )

  const scope = (ctx.settingsScope as any).bind({ namespace: 'searxng' })
  // The probe round-trip uses a second settings section (`searxng-probe`);
  // the controller binds it lazily and degrades when the host predates it.
  const ctrl = new SearxngController(scope as never, (ctx as any).settingsScope)
  // Subscribe lifecycle tied to this plugin fiber
  ctx.effect(() => {
    ctrl.bind()
    return () => ctrl.dispose()
  }, 'searxng: scope bind')

  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'searxng',
        locale: 'settings.searxng' as never,
        inject: () => ({ controller: ctrl }),
      } as never,
      SearxngCard as never,
    ),
  )
}
