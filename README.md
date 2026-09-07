# Webex Contact Center Webex App Agent Console POC

This project implements a single browser-based agent console for Webex Contact Center while retaining Webex App as the Calling media endpoint.

The browser does not register as a Calling endpoint, request microphone access, or transport audio. Webex Contact Center provides the routed interaction and agent workflow. The Contact Center task API now owns answer, decline, hold, resume, mute, unmute, DTMF, end, and all subsequent interaction controls while Webex App remains the media endpoint.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries, sequences, state ownership, recovery behavior, and production considerations.

## Implemented capabilities

| Area | Implementation |
|---|---|
| Authentication | Webex OAuth Authorization Code flow with PKCE and state validation |
| OAuth storage | Client secret and refresh token remain on the Express server |
| Agent identity | `/telephony/config/people/me` provides the display name shown in the console |
| Station discovery | Contact Center extensions, available endpoints, and preferred answer endpoint are retrieved through Calling configuration APIs |
| Contact Center startup | `@webex/contact-center` initialization, registration, team discovery, and extension station login |
| Agent state | Available and configured non-system Idle reason selection, including next-state selection during an active call |
| Incoming task | WxCC task events drive the interaction lifecycle |
| Native Webex App controls | Contact Center task UI capabilities and methods drive answer, decline, mute, unmute, and DTMF without browser call-ID matching |
| Native voice controls | Contact Center task capabilities and methods drive answer, decline, hold, resume, mute, unmute, DTMF, and end without browser call-ID matching or polling |
| Contact Center controls | Pause/resume recording, consult, transfer, consult transfer, consult end, consult conference, conference exit, and wrap-up |
| Endpoint preference | Optional persistence of the selected Webex Calling answer endpoint |
| Refresh recovery | SDK automated relogin, station-state restoration, and task hydration |
| Alerts | Web Audio ringtone and background operating-system notification with supported actions |
| User interface | One responsive desktop/mobile layout with icon-first call controls, consult and conference participant views, system/light/dark themes, custom accessible selectors, banners, and diagnostics |
| Logging | Structured backend lifecycle and action logs with allowlisted, non-PII browser diagnostics |

## Technology

- React 18 and TypeScript
- Vite 7
- Express 5
- `@webex/contact-center` 3.12.0-next.116, pinned for Webex App Better Together task controls
- Webex Calling configuration APIs and SDK-internal telephony controls
- Browser Notifications API, Service Worker API, and Web Audio API
- Vitest, Testing Library, and ESLint

Node.js 22 is recommended for local and hosted execution.

The Contact Center dependency is loaded only when initialization starts. This keeps the initial authentication and setup bundle substantially smaller while deferring the SDK cost to the point at which it is required.

`3.12.0-next.116` is a prerelease. The project includes two narrow TypeScript compatibility workarounds for that package: `tsconfig.app.json` resolves an upstream source-only metrics type import to its emitted declaration, and the controller locally augments `ITask` for the shipped `consultTransfer()` implementation that is missing from the prerelease interface. Revisit and remove both after upgrading to a stable release that contains the Better Together controls.

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

`spark:calls_read` and `spark:calls_write` remain required by the SDK's Webex App Better Together implementation. The application no longer calls `/telephony/calls` directly, but the SDK internally uses those Webex Calling operations for answer, decline, mute synchronization, and DTMF.

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
9. Answer or decline the call as soon as the SDK enables the corresponding task control.
10. During a connected call, optionally select the Available or Idle reason that should follow the interaction.
11. Use the task controls as applicable.
12. Start a consultation, then end it, complete the transfer, or merge it into a three-party conference.
13. From a conference, inspect participants or exit and leave the customer connected to the consulted party.
14. End the call and submit a wrap-up reason when required.
15. Use the dedicated Logout action for ordered cleanup.

## Control ownership

| Control | Owner | API or SDK behavior |
|---|---|---|
| Contact Center initialization | Contact Center SDK | `Webex.init`, ready event, and `cc.register()` |
| Station login/logout | Contact Center SDK | Extension login and ordered station cleanup |
| Available/Idle | Contact Center SDK | Agent-state APIs and configured auxiliary codes; the selector remains available during connected calls to establish the agent's following state |
| Answer | Contact Center SDK task | `task.accept()` routes internally to Webex App when `enableWxBetterTogether` is enabled and the task advertises an enabled `uiControls.main.accept` control |
| Decline | Contact Center SDK task | `task.decline()` routes internally to Webex App reject; the local offered-task view clears after success |
| Hold/resume | Contact Center SDK task | `task.hold()` and `task.resume()`, gated by `uiControls.main.hold` and synchronized by task events |
| Mute/unmute | Contact Center SDK task | `task.toggleMute({muted})`, gated by `uiControls.main.mute`; Webex App changes synchronize through `task:wxapp-mute-state-updated` |
| DTMF | Contact Center SDK task | `task.transmitDtmf({dtmf})`, gated by `uiControls.main.keypad`; digits are not sent to backend diagnostics |
| End call | Contact Center SDK task | `task.end()`, gated by `uiControls.main.end`; wrap-up remains backend-authoritative |
| Recording pause/resume | Contact Center SDK task | Available only when the interaction advertises pause/resume capability |
| Consult/transfer | Contact Center SDK task | Uses eligible agents and telephony queues returned by the SDK |
| Consult conference | Contact Center SDK task | `consultConference()` merges the held customer and consulted destination into a three-party conference |
| Conference exit | Contact Center SDK task | `exitConference()` removes the current agent and leaves the other conference parties connected |
| Wrap-up | Contact Center SDK task | Uses configured wrap-up codes after the task enters wrap-up |

The prerelease exposes `task.dropConferenceParticipant({participantId})`, but the POC participant view currently uses reconstructed display rows rather than authoritative SDK participant IDs. Drop remains unavailable until the conference roster is mapped to those IDs and the control is validated against the task state.

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

## Webex App Better Together SDK contract

The prerelease is initialized with:

```ts
config: {
  cc: {
    allowMultiLogin: false,
    allowAutomatedRelogin: true,
    enableWxBetterTogether: true,
  },
}
```

Although the implementation contains internal helpers named `acceptOnWebex`, `rejectOnWebex`, and `toggleMuteOnWebex`, application code uses the public task contract:

```ts
await task.accept();
await task.decline();
await task.hold();
await task.resume();
await task.toggleMute({muted: true});
await task.transmitDtmf({dtmf: '5'});
await task.end();
```

The SDK decides how to route these operations from the task's agent participant metadata and state machine. Answer, decline, mute, and DTMF use the Webex App Better Together path. Hold, resume, and end use Contact Center AQM task operations. The application binds action availability to `task.uiControls` and listens for task lifecycle events instead of inferring state from a Calling REST call ID.

The selected endpoint is still useful as the user's Webex Calling preference before station login. It is not passed to `task.accept()`; the SDK uses the Webex App device identifiers carried by the offered Contact Center task.

Upstream references:

- [Contact Center SDK introduction](https://developer.webex.com/webex-contact-center/docs/sdks/webex-contact-center-web-sdk-introduction)
- [Contact Center package](https://www.npmjs.com/package/@webex/contact-center)
- [Voice task routing on the upstream next branch](https://github.com/webex/webex-js-sdk/blob/next/packages/%40webex/contact-center/src/services/task/voice/Voice.ts)
- [Task controls and events on the upstream next branch](https://github.com/webex/webex-js-sdk/blob/next/packages/%40webex/contact-center/src/services/task/types.ts)

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
6. `task.uiControls` and task events restore the applicable controls and call state.

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
- Contact Center initialization, station login, state, task, recording, consult, conference, transfer, wrap-up, and logout
- SDK task answer, decline, hold, resume, mute, unmute, DTMF, and end outcomes reported through allowlisted non-PII diagnostics

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

Register the same HTTPS redirect URI on the Webex Integration. Express binds to Render's `PORT` on `0.0.0.0`, terminates OAuth callbacks, proxies the Calling configuration requests used by setup, and serves the built Vite assets.

`GET /healthz` returns HTTP 204 without reading OAuth state, invoking Webex APIs, or writing an operational log entry. Do not use `/api/oauth/status` as the infrastructure health check because it performs application-session work and records an OAuth status event.

The free Render tier is unsuitable for an agent session that must remain available because idle spin-down destroys the current in-memory OAuth session. For a bounded POC test, use an always-on single instance or accept that OAuth must be repeated after a process restart. Production requires a durable encrypted session store.

## Security and production limitations

Implemented controls:

- OAuth state validation and PKCE
- HTTP-only, same-site session cookie
- Secure session cookie in production
- Same-origin validation on state-changing proxy routes
- Server-side client secret and refresh token
- Allowlisted client diagnostic events
- Bounded Express JSON request size
- No PII or Webex identifiers in backend operational logs

Required before production:

- Replace the in-memory session map with a durable encrypted session store.
- Add explicit CSRF tokens in addition to same-origin and same-site protections.
- Define session expiration, revocation, cleanup, and key rotation.
- Add multi-tab ownership so one agent session has one controlling tab.
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

The test suite covers team normalization, station configuration, custom selectors, native SDK call controls and mute synchronization, call-control state, wrap-up behavior, idle reasons, and refresh recovery.

## Source layout

```text
server.mjs                    OAuth server, Calling configuration proxy, static host, structured logs
src/App.tsx                   Agent-console UI and workflow composition
src/WebexPocController.ts     Contact Center task and Webex App control orchestration
src/callingApi.ts             Same-origin browser API client and response types
src/stationConfiguration.ts   Extension and endpoint selection policy
src/sessionRecovery.ts        Same-tab recovery hint and profile-state mapping
src/backendDiagnostics.ts     Allowlisted lifecycle reporting transport
src/useCallAlerts.ts          Ringtone and operating-system notification lifecycle
src/SelectMenu.tsx            Accessible custom selector
src/useTheme.ts               System, light, and dark theme selection
public/call-alert-sw.js       Notification action delivery to the active page
```
