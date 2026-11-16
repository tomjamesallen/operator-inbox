// `@operator-inbox/core/api`: the local app's browser-safe contract. NOT
// re-exported from core's main barrel, which pulls node-only modules; import
// this subpath from both apps/cli and apps/web.

export * from '../inbox-code';
export * from '../inbox-metadata';
export * from './api';
export * from './inbox-api';
export * from './inbox-config-api';
export * from './keybindings-api';
export * from './serve-timeouts';
