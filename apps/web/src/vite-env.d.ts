/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define`.
declare const __GIT_COMMIT__: string
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  /**
   * Sentry ingest endpoint. Public by design — a DSN only grants permission to
   * submit events, never to read them — so it ships in the client bundle and is
   * set as a plain (non-secret) value in the deploy workflow.
   */
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_APP_ENV?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
