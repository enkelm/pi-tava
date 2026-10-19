# iPad PWA battery: notification audit

Date: 2026-10-19. Repository inspected at
`61a25cf171e18c26e5c50cabf0437d76f1ef68b4` (`pocket/pi-coop-f2d0d7`).

## Question and scope

Could notifications contribute to the reported battery drain after opening a live Herdr Terminal,
returning to an ordinary Collab thread, and leaving the app?

This is a source audit with synthetic diagnostics, not an iPad energy measurement. The served
revision, iPadOS version, actual push delivery rate, lifecycle events, and battery attribution have
not been established. No live notifications were sent, actual subscriptions/credentials inspected,
settings changed, or production code modified. Related findings are in
[the idle-work audit](ipad-idle-battery.md) and [the renderer audit](ipad-battery-renderer.md).

## Conclusion

Notifications are event-driven here, not a continuous background polling loop. Receiving a push
runs a short service-worker handler that requests a notification and a badge update; it does not
open/focus the app, reconnect its transport, or instantiate the terminal renderer.

A high delivery rate is still a plausible source of repeated background work. Every delivered
push requests notification/badge work, even when its tag matches a previous notification. Chat
has no notification-specific cooldown or digest; distinct run completions and distinct approvals
can also arrive repeatedly. Existing grouping reduces some outstanding messages/UI duplication,
not all delivery-driven wakeups. There is no evidence yet that this happened on the user's iPad,
nor a measurement of the energy cost per delivery.

For the reported sequence, notifications are not a Terminal-specific leak. If measured deliveries
are rare, the previously identified retained Herdr connection and hidden Work Items polling fit
the sequence better as code-level candidates. Their actual battery impact is also unmeasured.

## Confirmed client behavior

- `web/app.js:899–903` registers the worker at startup and subscribes `updateBadge` to store changes.
  `web/notify.js:10–20` memoizes registration, including a failed result. Settings mounts and Enable
  reuse it. There is no app-controlled periodic worker update or resubscription loop.
- `web/notify.js:29–56` skips badge calculation when its relevant inputs are unchanged, then skips
  native badge calls when the computed count is unchanged. A new sessions array can cause an
  O(number of sessions) scan, including unread checks, but not necessarily a native API call.
  There is no badge timer, retry loop, or visibility guard.
- `web/sw.js:10–42` handles each push with `showNotification(...)` and optional `setAppBadge()`.
  It supplies `tag` and `renotify: Boolean(data.tag)`. There is no client-side deduplication or
  rate limiting before these calls. Actual iPad alert behavior/support is not established by
  supplying these options.
- The push handler has no explicit fetch, timer, retry, window operation, or message to the page.
  Its `waitUntil` covers the notification/badge promises, not a continuing work loop. This does
  not assert that the browser performs no networking internally, e.g. for notification icons.
- `web/sw.js:45–113` only posts an approval response or opens/focuses/navigates the app after a
  notification action/click. Approval responses have one POST, no retry loop; failure can display
  another notification. Push receipt alone cannot take these paths.
- Install/activate handlers are finite. The worker's fetch handler only handles same-origin
  `POST /share` (`web/sw.js:159–170`). There are no worker timers, periodic-sync/background-sync,
  push-subscription-change, or notification-close handlers.
- `web/store.js:1874–1893` reports changed page visibility and suspends the main transport on hide;
  suspension closes it (`1085–1096`), and pagehide/offline also suspend (`1114–1130`). Notification
  receipt has no code path that reopens it. This is separate from the retained Herdr socket.

## Confirmed server behavior

### Eligibility and defaults

`src/server/alerts.ts:36–65` checks access, the selected preference, subscriptions, and whether the
user is already watching this conversation in a visible tab. `app.watching()` also considers PiP
(`src/server/app.ts:1496–1509`). A visible tab for the same user on another device can suppress
pushes for that conversation; merely having the app open on a different conversation does not.
This relies on the server's current client visibility state, not a measured iPad lifecycle trace.

All four preferences default on once a device is subscribed: completion, approval, chat, and
mention (`src/server/push.ts:24–29`). Notification permission/subscription itself is not silently
enabled; `web/notify.js` requests it from the Enable action.

### Trigger frequency and deduplication

- **Completion:** `src/server/app.ts:889–912` calls `runChanged` on actual busy-state transitions,
  not every streamed token/store update. `src/server/alerts.ts:69–135` waits three seconds after
  the run stops, cancels the pending timer if another run starts, and checks busy state before
  constructing the push. It skips absent/aborted assistant results, and can suppress a duplicate
  direct notification when PiP reports on the run. The timer is server-side and one-shot, not an
  iPad polling timer. Separate completed runs can each notify; there is no cross-run cooldown.
- **Approval:** `src/server/alerts.ts:139–185` records pending approval IDs synchronously before
  asynchronous sends, so repeated announcements of the same currently pending approval do not
  repeatedly push it. The set is in memory and tracks the current pending list, not a durable
  forever-seen ledger. Distinct approvals each qualify and use `high` urgency. Recipients are
  participants able to see the session, excluding viewers; an empty participant set falls back
  to configured users before access/role checks. No per-user approval digest/cooldown is present.
- **Chat/mention:** `src/server/collab.ts:90–156` uses the chat message/request ID to avoid pushing
  an already stored message again. `:178–228` pushes each newly created chat message to eligible
  participants; mentioned users use the mention path and are excluded from the ordinary chat
  path. The author is excluded. There is no notification batching/cooldown in these paths, so
  a busy conversation can issue one push per new message per eligible subscription.

No application-level push retry loop was found. `sendPush()` posts once, consumes the response,
and returns the provider status (`src/server/push.ts:204–251`). It has no application-supplied
abort timeout. `PushStore.notify()` fans out once per stored subscription using `Promise.allSettled`
and removes endpoints reported as 404/410 (`:437–489`). Provider/browser retries and delivery
policy are separate and were not measured. Server-side pending requests are not evidence of
continuous iPad execution.

### Grouping is not a cooldown

- `src/server/push.ts:228–238` uses a default 24-hour TTL, `normal` urgency unless overridden, and
  a `Topic` derived from the notification tag. TTL means provider retention, not keeping the
  service worker or PWA executing for 24 hours.
- Completion tags are `done-${conversationId}`; chat and mention tags share
  `chat-${conversationId}`; approval tags are per approval ID.
- RFC 8030 §5.4 describes replacement of **outstanding** same-topic messages. Messages already
  delivered cannot be prevented retroactively. Topic is not an application send-rate limiter.
- The worker's matching notification tag can replace an existing notification, but every received
  push still reaches its handler. `renotify: true` requests renewed user alerting for tagged
  notifications where supported; it does not implement deduplication. Do not equate one grouped
  notification visible in Notification Center with one received push or one device wake.
- `PushStore.subscribe()` replaces identical endpoints and caps subscriptions at ten per person
  (`src/server/push.ts:267,376–390`). Ordinary re-enabling does not accumulate identical endpoints.
  Multiple subscriptions mean fanout across subscriptions/devices, not necessarily multiple
  deliveries to the same iPad. Separately installed app identities may be separate subscriptions;
  whether that applies here was not investigated.

## Primary platform/protocol evidence

1. [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
   describes Home Screen web-app support, use of Apple's shared push service, Focus integration,
   and badges set in the foreground or while handling background push events. This supports an
   event-delivery model, not a need for this app to keep its own notification polling socket alive.
2. [WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)
   explicitly discusses energy costs of service-worker JavaScript for legacy push. Legacy delivery
   ensures a worker instance and dispatches a push event; WebKit requires a visible notification
   rather than allowing silent background pushes. The article introduces declarative support in
   iOS/iPadOS 18.4. This app sends its own flat JSON payload and uses `showNotification`; it has
   **not** adopted the declarative payload merely because a device supports it.
3. [RFC 8030 §5.2–5.4](https://www.rfc-editor.org/rfc/rfc8030.html#section-5.2)
   distinguishes TTL, urgency, and outstanding-message replacement. Its battery discussion
   supports reducing unnecessary deliveries, but does not quantify this application's drain or
   establish Apple's exact scheduling for these headers.

Declarative push is a possible later compatibility investigation, not an immediate conclusion:
keeping an installed worker can still dispatch its push handler for a declarative message. A
migration needs fallback handling, approval actions, badges, and click/PiP behavior checked;
changing a payload alone is not proof that JavaScript no longer runs.

## Diagnostics performed

Frontend helper executed actual `notify.js`/`sw.js` code against memory-only fake APIs:

| Synthetic input                               | Observed calls                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1,000 registration callers                    | 1 registration                                                                                       |
| 10,000 identical-input badge updates          | 1 initial clear                                                                                      |
| 1,000 new sessions arrays with the same count | No additional native badge calls                                                                     |
| 1,000 content-free pushes                     | 1,000 notification requests; 1,000 badge requests; no explicit fetches, timers, or client operations |

Main thread ran `node --test test/push.test.ts`: **4 passed, 0 failed**. These tests use generated
keys, fake fetch responses, and a temporary directory; they do not send live pushes or read the
production push store. They cover encryption, VAPID, the send path, subscription persistence/
validation, and removal of gone subscriptions—not iPad energy, alert scheduling, or all trigger
concurrency cases. No full suite/device tests were run. Markdown formatter was unavailable in
this checkout during the broader investigation; no packages were installed to work around it.

## Useful next steps, if a repair or measurement is requested

1. Compare otherwise similar idle windows using Settings → Notifications → **Notifications on this
   device** off/on. The app's per-device switch unsubscribes, making it a clearer isolation test
   than Focus or muting sound. Record duration, battery change, screen/network state, and workload;
   keep other background activity comparable. Do not promise an exact battery delta from one run.
2. Measure server send attempts by kind and worker push receipts with timestamps/counters only.
   Provider acceptance is not device delivery. Avoid bodies, credentials, raw subscription
   endpoints, approval content, and a new periodic diagnostic heartbeat. Visible grouped alert
   count alone is insufficient. Verify instrumentation does not change the lifecycle being tested.
3. If delivery rate is high, consider a bounded per-user/per-thread chat/completion cooldown or
   digest and avoiding renewed alerts for low-priority replacements. Keep urgent approvals timely,
   preserve authorization and request-ID non-replay, and define mention precedence explicitly.
4. Focused acceptance tests should cover sustained chat bursts, mention/chat non-duplication,
   completion debounce/cancellation, repeated pending-approval announcements, same-endpoint
   replacement, gone endpoints, visible-versus-hidden eligibility, and receipt never opening the
   app/transport/renderer. Measure actual iPad behavior separately; mocked call counts are not
   an energy benchmark.

No fixes, commits, restarts, or deployments were made by this investigation.
