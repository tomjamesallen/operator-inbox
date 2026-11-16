// The port `operator-inbox serve` binds by default, on 127.0.0.1 only.
// apps/web/vite.config.ts proxies /api here and repeats the number, because a
// Vite config cannot import a workspace package's TypeScript source. Its own
// module so the inbox contract (`inbox-api.ts`), which `api.ts` imports, can
// name it without importing `api.ts` back.
export const SERVE_DEFAULT_PORT = 7184;
