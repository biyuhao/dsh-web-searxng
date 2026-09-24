// Ambient fallbacks for browser-only faces that have no installable types
// in this repo (mirrors dsh-plugin-model-proxy/src/shims.d.ts). Host code
// uses the real @deepseek-ai/* packages; only the client needs these.
declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type ClientContext = any
}
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {}
declare module '@deepseek-ai/dsh-client-ui-plugin-manager/client' {}
