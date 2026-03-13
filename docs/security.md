# Security

## Secret Management

Zyra Editor supports **Secret nodes** (`control/secret`) for injecting sensitive values like API keys into pipeline steps without exposing them in YAML files.

### How Secrets Work

1. **Editor-side only** — Secret nodes store their plaintext value in the browser's memory. The value is **never written to pipeline YAML**; only the environment variable name is persisted.

2. **Serialization** — When a Secret node named `API_KEY` is wired to a step's arg port, the serializer replaces the value with a template reference `${API_KEY}`. The plaintext is stripped from the `_controls` section.

3. **Execution** — At runtime, `useExecution.ts` builds a secret map from all Secret nodes in the graph and resolves `${NAME}` references in request args **client-side** before submitting to the server. The server never sees the template syntax — only the resolved value, transmitted over the existing connection.

4. **Format strings** — When a Secret is wired to an arg that needs formatting (e.g., HTTP headers), the target arg can contain a `{}` placeholder. For example, `X-Api-Key: {}` wired from a Secret named `API_KEY` produces `X-Api-Key: ${API_KEY}`, which resolves to `X-Api-Key: <actual-value>` at execution time. Format strings are preserved in the YAML `_controls` edges via a `format` field.

### Encrypted localStorage Persistence

Secret values are persisted in `localStorage` so users don't have to re-enter them on every page load or YAML import. To avoid storing sensitive data as cleartext (flagged by CodeQL / OWASP), secrets are **encrypted at rest** using the Web Crypto API.

#### Encryption Details

| Property      | Value                                      |
|---------------|--------------------------------------------|
| Algorithm     | AES-256-GCM                                |
| Key derivation| PBKDF2, 100,000 iterations, SHA-256        |
| Key material  | `"zyra-secrets-key"` + `location.origin`   |
| Salt          | `"zyra-salt"` (static)                     |
| IV            | 12 bytes, randomly generated per save      |
| Storage format| Base64 of `IV (12 bytes) ‖ ciphertext`     |
| Storage key   | `zyra-secrets` in `localStorage`           |

#### Key Derivation

The encryption key is derived deterministically from the page origin using PBKDF2. This means:

- The key is **stable per origin** — secrets encrypted on `localhost:5173` can only be decrypted on `localhost:5173`.
- No separate key storage is needed (no IndexedDB, no extra localStorage entry).
- The key cannot be exported from the `CryptoKey` object (created with `extractable: false`).

#### Backward Compatibility

When `restoreSecrets()` fails to decrypt (e.g., on first load after upgrading from plaintext storage), it falls back to parsing the stored value as legacy plaintext JSON and **automatically re-encrypts** it.

#### Threat Model

This encryption protects against:

- **Casual inspection** — secrets are not visible as plaintext in browser DevTools → Application → Local Storage.
- **Static analysis tools** — CodeQL and similar scanners no longer flag cleartext secret storage.
- **Shoulder surfing** — the raw localStorage value is opaque base64.

This encryption does **not** protect against:

- **Malicious browser extensions** with access to the page's JS context.
- **XSS attacks** — if an attacker can execute JS on the page, they can call the same decrypt function.
- **Physical access** to an unlocked browser with DevTools open and the ability to run JS.

For high-security environments, secrets should be managed externally (e.g., environment variables on the server, a vault service) rather than stored in the browser.

### Run History Redaction

When pipeline runs are persisted to the server's SQLite database, all known secret values are **automatically redacted** from:

- **stdout / stderr** — CLI output that may echo request headers or parameters
- **Request args** — the `RunStepRequest.args` stored for cache key computation and debugging

Each occurrence of a secret value is replaced with `***REDACTED***` before the record is sent to the server. This is handled by `buildRunRecord()` in `@zyra/core`, which accepts the current secret values and scrubs them from all text fields.

Note: secrets may still appear transiently in **WebSocket log frames** streamed during execution, since those are forwarded in real-time from the CLI subprocess. The redaction applies only to the persisted run history.

### Implementation Files

| File | Role |
|------|------|
| `packages/editor/src/App.tsx` | `saveSecrets()`, `restoreSecrets()`, `encryptSecrets()`, `decryptSecrets()`, `getSecretsKey()` |
| `packages/editor/src/useExecution.ts` | `buildSecretMap()`, `resolveSecretRefs()` — client-side resolution before server submission; passes secret values to `buildRunRecord` for redaction |
| `packages/core/src/history.ts` | `buildRunRecord()` — redacts secret values from stdout, stderr, and request args before persistence |
| `packages/core/src/serializer.ts` | Strips secret values from YAML, emits `${NAME}` references, preserves `format` on control edges |
| `packages/core/src/deserializer.ts` | Restores `format` strings from `_controls` edges into target node `argValues` |
| `packages/editor/src/NodeDetailPanel.tsx` | Format input UI for linked args with `{}` placeholder |
