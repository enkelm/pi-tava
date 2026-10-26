# Pi provider extensions in pi-tava

Pi provider compatibility is an owner-controlled, restart-only module. It hosts approved ordinary Pi provider packages without modifying their source. It is not general Pi-extension support, a second interactive Pi agent, or a sandbox.

## Owner workflow

Settings → Providers has an owner-only **Provider packages** section above the ordinary sign-ins. It lists eligible packages installed on the **server**, not on the browser's device. Discovery reads package metadata without executing extensions. An owner can add an exact npm release on a fresh pi-tava installation (for example `npm:pi-provider-litellm@4.2.0`), select an installed release, configure public URLs/aliases, and request an update or rollback. API keys belong in the existing sign-in flow, not package settings.

Package selection/settings and the compatibility-module switch are requested configuration. They do not replace running code. Restart the server through the existing owner control to apply them. Ordinary Pi package enablement and settings stay unchanged. Update checks happen only when the owner requests an update; there are no automatic update checks or restarts. When the provider appears, use its ordinary API-key sign-in and **Refresh models** to discover its catalog; those do not change the running package release. Refresh validates a replacement before swapping; a failed refresh retains the working host and can be retried.

Selected dependencies are installed in separate pi-tava-managed release trees. They are not copied provider implementations or forks. Updates leave active dependencies and retained releases intact. Rollback prefers the actually applied selection when a different candidate is queued, otherwise the previous release; it does not rewind shared credentials. Installation currently supports npm packages on POSIX hosts. It disables lifecycle scripts and automatic peer installation, and rejects bundled Pi runtimes in favor of pi-tava's SDK. The owned installer is cancellable and bounded; shutdown stops its npm descendants. Provider code still runs with the server's operating-system rights after activation and can access credentials. Only trust packages you would run locally.

## First supported profile

The initial profile accepts `pi-provider-litellm` >=4.2.0, <5 native chat providers, with API-key authentication and discovered models. The package's own auth, discovery, transport policies and final-message handlers are used through Pi's public loader and extension runner. The compatibility proof targets 4.2.0; a version-range match is eligibility for the activation gate, not a guarantee about every future release.

Required provider behavior must work headlessly. Optional terminal presentation is not reproduced. While the module is enabled, pi-tava ignores `models.json` custom models and overrides: Pi's global-API fallback could otherwise bypass mandatory hosted hooks. Ordinary Pi files are untouched, and disabling the module plus restarting restores their use in pi-tava. Cursor's embedded agent/tool loop, SSO/ADC, command credential helpers, MCP/skills gateways, quota polling, custom model overrides, deferred/non-chat operations and classifier routing are outside this increment. Unsupported packages or capabilities get an explicit reason; installing an ordinary Pi extension does not establish compatibility.

pi-tava supplies isolated provider settings. LiteLLM's MCP, skills and budget features are disabled in those settings, without changing ordinary Pi's configuration. Credentials are resolved through the existing native credential mechanism, not copied into package metadata or telemetry.

## Runtime seam

`ModelRuntime` remains the app's canonical registration/catalog/auth interface. Startup initializes enabled packages before opening/resuming the harness. The provider host uses Pi's real public loader/runner APIs rather than a fabricated `ExtensionAPI` or imports of private provider helpers.

If a requested release fails activation, startup tries the last **actually applied** complete selection in fresh children, without rewriting the requested pins. Providers shows the failed candidate and retained active version separately. A fresh empty catalog keeps an auth-only provider registered so the owner can sign in and refresh models, without inventing fallback models. Durable work stays paused until a subsequent restart sees a usable catalog. If no retained selection works, the app opens in recovery mode: all Durable work remains paused, read-only views and owner provider/auth/restart controls remain available, and other mutations return 503. Spend reconciliation still records owed usage, but budget aborts cannot enable scheduling during recovery; enforcement starts only after a healthy startup is ready. This is a global v1 hold, not per-provider scheduling. Saving a fix does not unpause work; restart applies it. Disabling the module deliberately makes its models unavailable after restart.

Provider code that reads the process-wide Pi agent directory runs in a dedicated child process with a pi-tava-controlled directory. A provider host is trusted executable code, not an OS sandbox. Controlled discovery roots prevent unrelated workspace/global extensions from being loaded. Accepted catalogs use an explicit public `ModelsStore`, scoped to the release and public settings, outside temporary worker homes. New lanes and offline restarts hydrate that snapshot without restoring custom-model overlays.

Independent conversation lanes receive fresh extension activation state; requests in a lane serialize through finalization. Request context uses the physical model, persistent provider-session identity and cancellation signal. Calls without a conversation identity use an independent auxiliary lane, disposed after the call. The default host is bounded to four request workers plus one catalog worker, with 30-second idle expiry and idle LRU eviction. All-busy admission fails without spawning another worker. This keeps provider-ID-keyed extension state from mixing concurrent conversations and prevents unlimited retained conversation workers. The current public loader alias setup supports the root SDK imports used by LiteLLM, not arbitrary SDK subpath imports.

Headers, payloads, responses and final assistant messages pass through the supported Pi events. Critical hook errors fail closed. Native error diagnostics are sanitized before reaching Durable persistence. Message replacements are applied before both the terminal stream event and its result are exposed to Durable, so committed usage reflects the same message the caller receives. Optional registered tools and terminal commands are not silently exposed to Durable.

On shutdown, the harness stops before provider children are disposed and registrations removed. Package installation and runtime activation have separate ownership: staging does not execute or replace live providers, toggle the compatibility module or restart the server.

## Accounting limits

A request's estimated cost and a provider-reported header are alternative values, not additive charges. LiteLLM's proportional cost components are not provider-reported component prices. Unknown pricing is not free inference, and streaming headers are not guaranteed final invoices.

Cancellation or a process crash can occur after remote charges but before Durable commits usage. This feature does not claim a complete invoice ledger or patch delayed account observations into per-person spend. Quota telemetry and reconciliation remain separate later work.

## Validation

Use disposable app data, temporary credentials, synthetic provider packages and a local fake LiteLLM proxy. The important proofs are owner-only metadata/controls, consent before installation, no execution during discovery, restart-only application, immutable updates, native auth, required event transforms, concurrency-safe cost attribution, cancellation and child cleanup. No paid inference or live account data is needed.
