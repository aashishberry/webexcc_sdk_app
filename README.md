# Webex Contact Center and Calling REST Agent Console POC

This project implements a single browser-based agent console for Webex Contact Center while retaining Webex App as the Calling media endpoint.

The browser does not register as a Calling endpoint, request microphone access, or transport audio. Webex Contact Center provides the routed interaction and agent workflow. Webex Calling REST call controls operate the corresponding call on the selected or preferred Webex App endpoint.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries, sequences, state ownership, recovery behavior, and production considerations.

## Implemented capabilities

| Area | Implementation |
|---|---|
| Authentication | Webex OAuth Authorization Code flow with PKCE and state validation |
| OAuth storage | Client secret and refresh token remain on the Express server |
| Agent identity | `/telephony/config/people/me` provides the display name and email mapping |
| Station discovery | Contact Center extensions, available endpoints, and preferred answer endpoint are retrieved through Calling configuration APIs |
| Contact Center startup | `@webex/contact-center` initialization, registration, team discovery, and extension station login |
| Agent state | Available and configured non-system Idle reason selection |
| Incoming task | WxCC task events drive the interaction lifecycle |
| Call association | The WxCC task is matched to an inbound Calling REST call; `interactionId` and `callId` are not expected to be equal |
| Calling controls | Answer, decline, hold, resume, mute, unmute, DTMF, and hangup |
| Contact Center controls | Pause/resume recording, consult, transfer, consult transfer, consult end, and wrap-up |
| Endpoint preference | Optional persistence of the selected Webex Calling answer endpoint |
| Refresh recovery | SDK automated relogin, station-state restoration, task hydration, and active Calling call reassociation |
| Alerts | Web Audio ringtone and background operating-system notification with supported actions |
| User interface | Responsive layout, system/light/dark themes, custom accessible selectors, banners, and agent diagnostics timeline |
| Logging | Structured backend lifecycle and action logs with allowlisted, non-PII browser diagnostics |

## Technology

- React 18 and TypeScript
- Vite 7
- Express 5
- `@webex/contact-center` 3.12.0
- Webex Calling REST APIs
- Browser Notifications API, Service Worker API, and Web Audio API
- Vitest, Testing Library, and ESLint

Node.js 22 is recommended for local and hosted execution.

## Webex integration configuration

Create a Webex Integration and register the callback used by the application.

Local callback:

```text
http://localhost:5173/api/oauth/callback
```

Hosted callback:

```text
https://<host>/api/oauth/callback
```

The value must also be supplied as `WEBEX_REDIRECT_URI` and must match a redirect URI registered on the Webex Integration.

Configure these user scopes:

```text
spark:telephony_config_read
spark:telephony_config_write
spark:calls_read
spark:calls_write
cjp:user
cjp:config
cjp:config_read
cjp:config_write
```

`spark:telephony_config_write` is required only when the user chooses to persist a preferred answer endpoint. Remove that feature and scope together if endpoint preference will be read-only.

The Webex OAuth client must also be authorized to use the Contact Center SDK service-discovery path in the target environment. An OAuth token containing the correct scopes does not by itself resolve a client allowlisting failure from U2C service discovery.

## Environment configuration

Copy the example file and supply the integration credentials:

```bash
cp .env.example .env
```

```text
WEBEX_CLIENT_ID=<integration-client-id>
WEBEX_CLIENT_SECRET=<integration-client-secret>
WEBEX_REDIRECT_URI=http://localhost:5173/api/oauth/callback
WEBEX_SCOPES=spark:telephony_config_read spark:telephony_config_write spark:calls_read spark:calls_write cjp:user cjp:config cjp:config_read cjp:config_write
PORT=5173
```

Do not commit `.env` or expose `WEBEX_CLIENT_SECRET` to the React bundle.

## Local execution

```bash
npm ci
npm run dev
```

Open `http://localhost:5173` in a normal browser profile.

Production-mode local execution:

```bash
npm run build
npm start
```

## Agent workflow

1. Select Continue with Webex and complete OAuth.
2. Confirm or select the discovered Calling extension.
3. Confirm or select the answer endpoint.
4. Optionally persist the answer endpoint as the Webex Calling preference.
5. Initialize Contact Center.
6. Select an assigned team and complete extension station login.
7. Change agent state to Available.
8. Route a Webex Contact Center voice interaction to the agent.
9. Confirm that the task is associated with one Calling REST call.
10. Answer or decline the call.
11. Use Calling and Contact Center controls as applicable.
12. End the call and submit a wrap-up reason when required.
13. Use the dedicated Logout action for ordered cleanup.

## Control ownership

| Control | Owner | API or SDK behavior |
|---|---|---|
| Contact Center initialization | Contact Center SDK | `Webex.init`, ready event, and `cc.register()` |
| Station login/logout | Contact Center SDK | Extension login and ordered station cleanup |
| Available/Idle | Contact Center SDK | Agent-state APIs and configured auxiliary codes |
| Answer | Calling REST | Answers on the selected endpoint, or the primary-device fallback |
| Decline | Calling REST | Ends the alerting Calling leg with `hangup`; the local offered-task view clears immediately |
| Hold/resume | Calling REST | Uses the active Calling `callId` |
| Mute/unmute | Calling REST | Enabled only when the call reports `muteCapable` |
| DTMF | Calling REST | Sends a validated digit sequence; digits are not logged |
| Hangup | Calling REST | Ends the active Calling leg |
| Recording pause/resume | Contact Center SDK task | Available only when the interaction advertises pause/resume capability |
| Consult/transfer | Contact Center SDK task | Uses eligible agents and telephony queues returned by the SDK |
| Wrap-up | Contact Center SDK task | Uses configured wrap-up codes after the task enters wrap-up |

## Station and endpoint selection

The server combines these APIs:

```text
GET /telephony/config/people/me
GET /telephony/config/people/me/settings/contactCenterExtensions
GET /telephony/config/people/me/settings/preferredAnswerEndpoint
GET /telephony/config/people/me/settings/availablePreferredAnswerEndpoints
```

The selection logic:

1. Prefer the primary Contact Center extension.
2. Restrict answer endpoints to those associated with the selected extension when associations are returned.
3. Prefer an existing usable preferred endpoint.
4. Otherwise select a single connected Webex application endpoint when unambiguous.
5. Otherwise require explicit user selection.
6. Disable endpoints reported as `NOT_CONNECTED`.

When the user selects Use as my preferred Webex Calling answer device, the server writes the preference with:

```text
PUT /telephony/config/people/me/settings/preferredAnswerEndpoint
```

## Call association

For a new offer, candidate calls must have:

- A Calling call identifier
- Inbound `terminator` personality
- `alerting` state

Caller number and creation time are used to rank multiple candidates. If two candidates remain equally plausible, Answer stays disabled.

During refresh recovery, the matcher also accepts inbound `connected`, `held`, and `remoteHeld` calls. It selects a single candidate or a unique caller-number match; it does not guess between ambiguous active calls.

Active calls are polled every 1.5 seconds to synchronize connected, held, mute, and ended state. Successful polling is not written to backend logs.

## Refresh recovery

After successful Contact Center initialization, the browser stores a recovery hint in `sessionStorage` containing only:

- Extension
- Selected answer-endpoint metadata

The access token is not stored in browser storage. On a same-tab refresh:

1. The browser retrieves the current OAuth state and access token from the same-origin server session.
2. The Contact Center SDK initializes with `allowAutomatedRelogin: true`.
3. `cc.register()` attempts the SDK silent relogin.
4. The returned profile is authoritative for station login, team, device type, extension, and auxiliary state.
5. `task:hydrate` restores an active Contact Center interaction.
6. The application lists Calling calls and associates a matching active inbound call.
7. Applicable call controls are restored.

If no backend station exists, the UI stops at normal station login. Recovery failure displays an error and does not issue a station logout against a possibly valid backend session. Explicit Logout clears the recovery hint.

Recovery requires the Express OAuth session to remain available. The current in-memory session implementation is lost on server restart, redeployment, process replacement, or Render free-tier spin-down.

## Browser call alerts

The Alerts control performs two explicit user-authorized operations:

- Resumes a Web Audio context for the ringtone.
- Requests browser notification permission.

When an incoming task is ringing:

- The application plays a repeating Web Audio ringtone while alerts are enabled.
- A service-worker notification is shown only while the page is hidden.
- Supported browsers expose Answer and Decline notification actions.
- Answer and Decline are sent to the still-running page through `postMessage`.
- Selecting the notification body focuses or opens the application.
- The notification closes when the call stops ringing or the page becomes visible.

This is not a Web Push implementation. The agent page and SDK session must remain active. Notifications require HTTPS outside localhost. Chrome private browsing does not deliver site notifications. Action-button support depends on the browser and operating system.

## Operational logging

The server emits one-line JSON records suitable for Render log streams. Covered events include:

- Server startup
- OAuth authorization, callback, status, and logout
- Calling profile and station-configuration discovery
- Contact Center initialization, station login, state, task, recording, consult, transfer, wrap-up, and logout
- Calling call-control start, success, failure, action, and duration
- Calling API and polling failures

Contact Center SDK actions occur directly in the browser. The browser reports allowlisted lifecycle milestones to `POST /api/diagnostics/events`. The server accepts only known events, outcomes, and fields.

Logs exclude tokens, names, email addresses, phone numbers, endpoint IDs, team IDs, interaction IDs, call IDs, DTMF digits, and destination IDs. A request ID and short SHA-256-derived session reference provide correlation without recording the session cookie.

The Webex browser logger is configured at `error`. Application browser-console output is limited to actionable failures. The in-app diagnostics timeline is separate and may contain interaction-specific identifiers required for POC troubleshooting.

## Render deployment

Create a Render Web Service, not a Static Site.

```text
Build command: npm ci && npm run build
Start command: npm start
Health check path: /healthz
```

Configure:

```text
WEBEX_CLIENT_ID=<integration-client-id>
WEBEX_CLIENT_SECRET=<integration-client-secret>
WEBEX_REDIRECT_URI=https://<service-name>.onrender.com/api/oauth/callback
WEBEX_SCOPES=<configured scopes>
NODE_VERSION=22
```

Register the same HTTPS redirect URI on the Webex Integration. Express binds to Render's `PORT` on `0.0.0.0`, terminates OAuth callbacks, proxies Calling REST requests, and serves the built Vite assets.

`GET /healthz` returns HTTP 204 without reading OAuth state, invoking Webex APIs, or writing an operational log entry. Do not use `/api/oauth/status` as the infrastructure health check because it performs application-session work and records an OAuth status event.

The free Render tier is unsuitable for an agent session that must remain available because idle spin-down destroys the current in-memory OAuth session. For a bounded POC test, use an always-on single instance or accept that OAuth must be repeated after a process restart. Production requires a durable encrypted session store.

## Security and production limitations

Implemented controls:

- OAuth state validation and PKCE
- HTTP-only, same-site session cookie
- Secure session cookie in production
- Same-origin validation on state-changing proxy routes
- Server-side client secret and refresh token
- Calling action and DTMF validation
- Allowlisted client diagnostic events
- Bounded Express JSON request size
- No PII or Webex identifiers in backend operational logs

Required before production:

- Replace the in-memory session map with a durable encrypted session store.
- Add explicit CSRF tokens in addition to same-origin and same-site protections.
- Define session expiration, revocation, cleanup, and key rotation.
- Add multi-tab ownership so one agent session has one controlling tab.
- Replace Calling polling with `telephony_calls` webhooks and a server-to-browser delivery channel.
- Add centralized monitoring, alerting, and log-retention policy.
- Add rate limits for OAuth, diagnostics, and call-control proxy routes.
- Validate browser, operating-system, Webex App, endpoint, and tenant compatibility.
- Review npm advisories inherited through the Webex dependency tree and upgrade when remediated packages are available.

## Validation

```bash
npm test
npm run lint
npm run build
```

The test suite covers team normalization, station configuration, custom selectors, call matching, call-control state, wrap-up behavior, idle reasons, and refresh recovery.

## Source layout

```text
server.mjs                    OAuth server, Calling API proxy, static host, structured logs
src/App.tsx                   Agent-console UI and workflow composition
src/WebexPocController.ts     Contact Center and Calling lifecycle orchestration
src/callingApi.ts             Same-origin browser API client and response types
src/callMatching.ts           New-offer and refresh-recovery call association
src/stationConfiguration.ts   Extension and endpoint selection policy
src/sessionRecovery.ts        Same-tab recovery hint and profile-state mapping
src/backendDiagnostics.ts     Allowlisted lifecycle reporting transport
src/useCallAlerts.ts          Ringtone and operating-system notification lifecycle
src/SelectMenu.tsx            Accessible custom selector
src/useTheme.ts               System, light, and dark theme selection
public/call-alert-sw.js       Notification action delivery to the active page
```
