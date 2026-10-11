# Shared native providers: smallest production seam

2026-10-11. Source inspection against installed `@earendil-works` 1.1.0 packages. No implementation, tests, live auth, credential-file inspection, inference, extension activation, or restart. Only this note was written; unrelated changes were preserved.

## Conclusion — recommendation

**Native pi-ai `Provider` already supplies the shared inference/auth/catalog interface.** Reuse provider implementations with small ordinary-Pi and Coop adapters; do not invent a replacement provider schema or expose the entire `ModelRuntime` through `PocketHost`.

For the first production increment, prefer an **explicitly owner-selected, startup-only provider loader**, beside runtime creation and before Harness creation/resumption. Keep provider resource ownership and cleanup inside one deep module. Defer hot replacement until its semantics are deliberately designed.

## Verified facts

### 1. Native Provider is sufficient for the runtime payload, not the lifecycle

`Provider` owns identity, required auth semantics, catalogs, credential-specific availability filtering, dynamic discovery, normalized chat streams, and optional deferred/image/classifier operations. Discovery receives credentials, cached models, abort signal, and generation-checked publication. It does **not** define disposal, telemetry, or change subscriptions. [1]

Ordinary Pi accepts it as `pi.registerProvider(provider)`; Coop's runtime accepts the same interface as `registerNativeProvider(provider)`. Durable receives `Models`, the catalog/auth/request interface, rather than installation functions. Shared credentials alone do not install provider implementations. [2]

**Implication:** a native provider plus host-owned lifecycle is enough. Pi commands/event hooks, polling, usage accounting and embedded tool loops remain separate adaptations.

### 2. Startup is a small existing seam

Coop creates `ModelRuntime`, calls synchronous `configureModels`, checks availability, loads Durable extensions, and supplies the same runtime to `Harness.open`. Recovery and subscriptions precede `harness.resume()`. `configureModels` is explicitly a scripted-provider test injection point, not an owner-facing loader. `PocketHost` exposes model resolution but no provider registration. [3]

**Recommendation:** put asynchronous provider installation before Harness opening, including bounded cache restoration/discovery and availability synchronization. Preserve `configureModels` for tests. Owner-approved modules should be off by default and loaded from server-controlled configuration, never automatically from a conversation's working directory or ordinary Pi extension discovery.

### 3. Current drop-in loader does not own provider rollback/disposal

The loader imports a module and invokes its factory **before** validating returned extension/tool names. It then installs Durable extensions. Its “keep previous version” behavior protects registry entries, not factory side effects. Disable/deletion only uninstall returned extensions; close only stops filesystem watchers and reload timers. There is no module disposer or provider ownership tracking. [4]

Adding `host.registerProvider` alone would therefore permit failed factories to leave registrations/pollers behind, and disabling a module would not undo them. Existing name checks do not cover provider IDs. Drop-ins execute with owner rights, not in a sandbox. Enable/reload authorization lives in the HTTP layer. [4][5]

| Choice                        | Main advantage                                                 | Cost/risk                                                                                                           |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Extend existing drop-ins      | Reuse owner toggles, notices and reload UI                     | Must add staged side-effect ownership, rollback, disposal, inference/login draining and provider-name checks        |
| Dedicated startup-only loader | Small integration beside model startup; unchanged Durable host | Needs owner selection, deterministic loading, startup failure cleanup and notices; changes require approved restart |

**Recommendation:** the second choice is safer initially; the first is not a “small host-method addition.” No full module schema is proposed here.

### 4. Concrete lifecycle caveats

- **Upsert and aliases:** native registration checks only a nonempty trimmed ID; it does not normalize IDs or reject duplicates. It replaces the native entry and removes a same-ID compatibility registration. Unregistration is `unregisterProvider(id)`, not a native-specific method, and can reveal remaining built-in/configuration/virtual-model layers. Native providers can still receive `models.json` overlays. Reject accidental clashes and track ownership; each intended account alias needs a distinct stable ID. [6]
- **Refresh completion:** registration/unregistration start an unawaited cache-only refresh. `getAvailable()` checks auth/filtering, not fresh discovery. Explicitly await refresh/snapshot synchronization rather than assuming registration completion means initialization finished. Default runtime creation does not enable network discovery; explicit refresh ordinarily does unless offline. [6][7]
- **Replacement is not cancellation:** pi-ai replacement/deletion supersedes catalog refresh generations and aborts those refreshes. It does not dispose providers or cancel inference. Request preparation captures the effective provider before awaiting auth and dispatches through that object; already dispatched streams can retain old implementations. No active-request lease/drain protocol is provided. [8]
- **Auth can outlive installation:** login captures a provider and later writes its credential by ID, without registration-generation checks. ModelRuntime serializes credential operations, but not provider installation against them. Coop flows lack provider ID, and shutdown aborts without awaiting flow completion. Disable/replacement needs an explicit login cancellation/drain policy. Credential synchronization can fail after credentials were saved. [9]
- **Notifications are host-owned:** Coop broadcasts `models` after successful login/logout; the provider panel reloads on that event. There is no runtime subscription contract or corresponding automatic registration/discovery broadcast. Arrange scoped discovery, availability synchronization and notifications explicitly. Configured availability is not quota or proof of successful inference. [7][10]
- **Disposal/polling:** app shutdown stops watching/login, then awaits Harness close; it does not dispose provider modules. Stop timers, abort/join discovery/telemetry and suppress late results, but retain inference resources until Harness tasks have joined. Native catalog generation checks do not protect private telemetry writes. Existing LiteLLM budget polling is Pi-session-event-driven, not native Provider lifecycle. [11]
- **Restart/missing providers:** Durable checkpoints store model references and re-resolve them in prepare/request/deferred polling. A missing model terminates the run as unanswered `no_model`, not “wait until the provider returns.” Known models with failed auth enter request-error handling. Deferred cancellation also depends on model resolution. Skipping failed provider installation and resuming immediately can fail pending work. Withholding `resume()` alone is not a full hold: progress-requesting calls also enable scheduling. [12]

## Remaining decisions

1. Owner allowlist/location and version checks; whether deliberate built-in/configuration overlays are allowed.
2. Provider startup failure policy: fail startup, or start with genuinely held affected work? No silent provider fallback.
3. Offline startup versus bounded discovery; refresh after login and external Pi auth changes; update notifications.
4. Cleanup/error timeouts and whether only resource-free native factories ship initially. Hot replacement is deferred.

Later verification should use isolated scripted transports and credentials. No runtime disposal, in-flight replacement or adapter compatibility guarantees were exercised. Cursor's embedded agent/tool loop is outside what native registration alone proves.

## Primary sources

Paths are repository-relative except `$HOME`, the local owner's home directory. Citations refer to source, not secret data.

1. `node_modules/@earendil-works/pi-ai/dist/models.d.ts:7-125`.
2. `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1288-1349`; `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:268-286,309-328`; `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts:110-121`; `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:393`.
3. `src/server/app.ts:105-113,237-318,322-368`; `src/server/host.ts:119-146`; `test/helpers.ts:77`.
4. `src/server/reload.ts:234-281,318-409,442-451,488-497`; `docs/extensions.md:69-76`.
5. `docs/extensions.md:9-11`; `src/server/http/api.ts:518-547`; `docs/architecture.md:164`.
6. `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:125-169,627-705`; `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:344-425`.
7. `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:78-114,306-328,582-625`.
8. `node_modules/@earendil-works/pi-ai/dist/models.js:47-60,122-171,174-219`; `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:447-484,488-515`; `node_modules/@earendil-works/pi-durable/dist/harness/generation.js:95-120`.
9. `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:10-100,157-243`; `node_modules/@earendil-works/pi-ai/dist/models.js:351-413`; `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:15-29,380-419,568-580`; `src/server/providers.ts:13-18,165-169`. Existing owner login/device-ID interaction: `src/server/providers.ts:55-154`; `src/server/http/api.ts:555-600`. Default auth store/locking: `node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:19,85-155,282`.
10. `src/server/providers.ts:98-103,150-163`; `src/server/models.ts:51-83`; `web/sheets/providers.js:9-15`; complete runtime interface: `node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts:36-150`.
11. `src/server/app.ts:1698-1735`; `node_modules/@earendil-works/pi-durable/dist/harness/harness.js:205-212`; `$HOME/.pi/agent/npm/node_modules/pi-provider-litellm/src/budget.ts:353-457,512-520`.
12. `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:9-12,507-513`; `node_modules/@earendil-works/pi-durable/dist/harness/generation.js:35-38,95-120,137-143,168-180,224-242`.

Version evidence: `package.json:46-49` and `node_modules/@earendil-works/{pi-ai,pi-coding-agent,pi-durable}/package.json:3`.
