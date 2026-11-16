// `@operator-inbox/core/api`: the local app's browser-safe contract. NOT
// re-exported from core's main barrel, which pulls node-only modules; import
// this subpath from both apps/cli and apps/web.

export * from '../attachment';
export * from '../comments';
export * from '../drawing';
export * from '../html-block';
export * from '../inbox-code';
export * from '../inbox-metadata';
export * from '../macros';
export * from './api';
export * from './inbox-api';
export * from './inbox-config-api';
export * from './keybindings-api';
export * from './macros-api';
export * from './readout-api';
export * from './serve-timeouts';
