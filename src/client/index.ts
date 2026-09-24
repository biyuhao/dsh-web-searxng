/** Browser card registration. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SearxngCard } from './SearxngCard.js'
import { SearxngController } from './controller.js'
import { en, zh } from './locales.js'

export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register('settings.searxng' as never, { en, zh } as never),
    'searxng: locale',
  )

  const scope = ctx.configForms.get('searxng')
  const ctrl = new SearxngController(scope as never)
  // Lifecycle tied to the plugin fiber.
  ctx.effect(() => {
    ctrl.bind()
    return () => ctrl.dispose()
  }, 'searxng: scope bind')

  ctx.effect(() => ctx.configForms.whileServed(['searxng'], () => ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: 'dsh-web-searxng',
        locale: 'settings.searxng' as never,
        inject: () => ({ controller: ctrl }),
      } as never,
      SearxngCard as never,
    ),
  )), 'searxng: config page')
}
