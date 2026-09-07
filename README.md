# Webex Contact Center Agent Console

This project implements a single responsive agent console for Webex Contact Center with three profile-controlled voice connection modes:

- Webex App through a Webex Calling extension
- Native browser WebRTC
- An agent dial number

Webex Contact Center provides the routed interaction and agent workflow in every mode. The Contact Center task API owns answer, decline, hold, resume, mute, unmute, DTMF, end, and subsequent interaction controls. Media remains on the selected station: Webex App, this browser, or the dialed phone.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries, sequences, state ownership, recovery behavior, and production considerations.

## Implemented capabilities

| Area | Implementation |
|---|---|
| Authentication | Webex OAuth Authorization Code flow with PKCE and state validation |
| OAuth storage | Client secret and refresh token remain on the Express server |
| Agent identity | `/telephony/config/people/me` provides the display name shown in the console |
| Station discovery | Contact Center extensions, available endpoints, and preferred answer endpoint are retrieved through Calling configuration APIs |
| Contact Center startup | `@webex/contact-center` initialization, registration, team discovery, profile capability discovery, and station login |
| Station modes | Profile-gated Webex App (`EXTENSION`), browser WebRTC (`BROWSER`), and dial number (`AGENT_DN`) login |
| Browser media | Explicit microphone preflight and remote-audio playback from `task:media` |
| Agent state | Available and configured non-system Idle reason selection, including next-state selection during an active call |
| Incoming task | WxCC task events drive the interaction lifecycle |
| Native Webex App controls | Contact Center task UI capabilities and methods drive answer, decline, mute, unmute, and DTMF without browser call-ID matching |
| Native voice controls | Contact Center task capabilities and methods drive answer, decline, hold, resume, mute, unmute, DTMF, and end without browser call-ID matching or polling |
| Contact Center controls | Pause/resume recording, consult, transfer, consult transfer, consult end, consult conference, conference exit, and wrap-up |
| Consult and conference orchestration | SDK capability-gated call-leg switching, consult completion, conference handoff, and participant removal using authoritative participant IDs when supplied |
| Agent assistance | Explicit transcript start/stop lifecycle, live and recovered transcripts, real-time assistance requests and feedback, and mid-call/post-call summary requests through `apiAIAssistant` |
| Agent performance | Current-day completed interactions, average connected time, average hold time, and average wrap-up time through GraphQL Search |
| Endpoint preference | Optional persistence of the selected Webex Calling answer endpoint |
| Refresh recovery | SDK automated relogin, station-state restoration, and task hydration |
| Alerts | Web Audio ringtone and background operating-system notification with supported actions |
| User interface | One responsive desktop/mobile lifecycle workspace with a persistent state timer, stable call-control dock, interaction context and AI panel, system/light/dark themes, accessible selectors, banners, and a diagnostics drawer |
| Logging | Structured backend lifecycle and action logs with allowlisted, non-PII browser diagnostics |

## Technology

- React 18 and TypeScript
- Vite 7
- Express 5
- `@webex/contact-center` 3.12.0-next.116, pinned for Webex App Better Together task controls
- Webex Calling configuration APIs and SDK-internal telephony controls
- Webex Contact Center GraphQL Search API for capability-gated agent statistics
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

`cjp:config` or `cjp:config_read` authorizes the GraphQL Search request. Webex also requires the signed-in user to have the Administrator or Supervisor role. When that role is absent, the application keeps all agent and call workflows available and presents reporting as unavailable.

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
2. Connect Contact Center to load the agent profile, teams, and permitted voice options.
3. Choose Webex App, This browser, or Dial number. Options not enabled by the agent profile remain visible but unavailable.
4. Select an assigned team and provide the fields required by the chosen mode.
5. For Webex App, confirm the extension and answer endpoint and optionally persist the endpoint preference.
6. For browser WebRTC, grant microphone access. The SDK uses the system-default microphone and browser audio output.
7. Complete station login.
8. Change agent state to Available and handle the interaction with the task controls.
9. During a connected call, optionally select the Available or Idle reason that should follow the interaction.
10. Use Context, Transcript, Assist, and Summary without leaving the active interaction.
11. Start a consultation, switch between call legs, end it, complete the transfer, or merge it into a conference.
12. During a conference, manage participants or hand the conference over when the SDK enables those controls.
13. End the call, submit a wrap-up reason when required, and use Logout for ordered cleanup.

## Control ownership

| Control | Owner | API or SDK behavior |
|---|---|---|
| Contact Center initialization | Contact Center SDK | `Webex.init`, ready event, and `cc.register()` |
| Station login/logout | Contact Center SDK | `stationLogin()` with `BROWSER`, `EXTENSION`, or `AGENT_DN`, followed by ordered station cleanup |
| Available/Idle | Contact Center SDK | Agent-state APIs and configured auxiliary codes; the selector remains available during connected calls to establish the agent's following state |
| Answer | Contact Center SDK task | `task.accept()` uses native WebRTC for browser login or Better Together for an eligible Webex App task; availability comes from `uiControls.main.accept` |
| Decline | Contact Center SDK task | `task.decline()` routes internally to Webex App reject; the local offered-task view clears after success |
| Hold/resume | Contact Center SDK task | `task.hold()` and `task.resume()`, gated by `uiControls.main.hold` and synchronized by task events |
| Mute/unmute | Contact Center SDK task | `task.toggleMute({muted})`, gated by `uiControls.main.mute`; Webex App changes synchronize through `task:wxapp-mute-state-updated` |
| DTMF | Contact Center SDK task | `task.transmitDtmf({dtmf})`, gated by `uiControls.main.keypad`; digits are not sent to backend diagnostics |
| End call | Contact Center SDK task | `task.end()`, gated by `uiControls.main.end`; wrap-up remains backend-authoritative |
| Recording pause/resume | Contact Center SDK task | Available only when the interaction advertises pause/resume capability |
| Consult/transfer | Contact Center SDK task | Uses eligible agents and telephony queues returned by the SDK |
| Consult conference | Contact Center SDK task | `consultConference()` merges the held customer and consulted destination into a three-party conference |
| Switch consult leg | Contact Center SDK task | `switchCall()` changes the active main/consult leg when the active leg exposes the switch control |
| Conference participant removal | Contact Center SDK task | `dropConferenceParticipant({participantId})`, enabled only for authoritative participant IDs returned by task data |
| Conference handoff | Contact Center SDK task | `transferConference()`, gated by the active task UI control |
| Conference exit | Contact Center SDK task | `exitConference()` removes the current agent and leaves the other conference parties connected |
| Wrap-up | Contact Center SDK task | Uses configured wrap-up codes after the task enters wrap-up |
| Transcript and AI assistance | Contact Center SDK AI Assistant | Profile-gated `GET_TRANSCRIPTS` START/STOP requests, historic and live transcripts, suggested responses, user-action feedback, and summary requests remain interaction-scoped |

Conference rows are reconstructed only while the SDK participant map is unavailable. Reconstructed rows cannot be removed. As soon as task data supplies authoritative participant IDs, the console enables participant removal for non-host participants and delegates the action to `task.dropConferenceParticipant()`.

## Interaction insights and AI

The active interaction opens a companion panel with four views:

- Context: caller identity plus queue, reason, IVR path, entry point, and language when supplied by task data.
- Transcript: historic transcript recovery after hydration and live transcript events during the conversation.
- Assist: `getRealTimeAssistance()` requests, suggested responses, copy action, and helpful/not-helpful feedback.
- Summary: mid-call and post-call requests through the AI Assistant event API.

The UI renders empty states when the tenant, agent profile, or interaction does not enable an AI or reporting capability. It does not invent transcript, summary, queue, or performance values.

When `profile.aiFeature.realtimeTranscripts.enable` is true, the console explicitly sends `GET_TRANSCRIPTS` with `action: START` after `task:assigned`. This supplements the SDK's automatic transcript lifecycle and covers task sequences where the later media-fork update does not cause the SDK to issue the start request. The application deduplicates its own start request per interaction, reports request status in the Transcript tab, and exposes a retry after a failed request. The first `REAL_TIME_TRANSCRIPTION` event moves the presentation from requested to active. On task end or wrap-up, an application-started stream is paired with `action: STOP`.

The transcript path remains profile-gated. If the SDK registration profile does not advertise real-time transcription, the UI states that explicitly and does not send an unsupported request. See the [Webex Contact Center task transcription contract](https://developer.webex.com/webex-contact-center/docs/sdks/webex-contact-center-web-sdk-tasks#real-time-transcriptions).

After Contact Center registration, the controller resolves the SDK-discovered regional `wcc-api-gateway` and asks the same-origin server for current-day performance. The server validates the regional Webex hostname and time window, refreshes the OAuth token when necessary, and posts a `taskDetails` aggregation to `/search`. The query uses `endedTime`, telephony media, and the registered profile's `agentId` to return:

- completed interactions where the user was the last handling agent;
- average connected duration;
- average hold duration; and
- average wrap-up duration.

Durations returned in milliseconds are normalized to seconds before entering the controller snapshot. The browser's local midnight defines the beginning of “Today.” A denied role, unavailable regional service, or rejected tenant schema changes only the reporting state; it does not fail SDK initialization, station login, agent state, or active call controls. The cards include a manual refresh action because historical reporting ingestion is not guaranteed to be immediate.

Reporting references:

- [Search API reference](https://developer.webex.com/webex-contact-center/docs/api/v1/search/search)
- [Getting started with GraphQL Search](https://developer.webex.com/webex-contact-center/docs/getting-started-with-search-api)
- [Statistics REST to GraphQL migration guide](https://developer.webex.com/webex-contact-center/docs/migrate-from-stats-rest-api-to-graphql)

## Station modes and endpoint selection

The registered profile is authoritative for station availability through `loginVoiceOptions` and `webRtcEnabled`:

| UI option | SDK login option | Required input | Media endpoint |
|---|---|---|---|
| Webex App | `EXTENSION` | Extension; optional preferred answer endpoint | Registered Webex Calling device |
| This browser | `BROWSER` | Microphone permission | Browser WebRTC microphone and remote audio |
| Dial number | `AGENT_DN` | Dial-plan-valid number | External or PSTN phone |

For WebRTC, `task.accept()` obtains the local microphone stream. The application also performs an earlier permission preflight during station login and attaches the remote audio track emitted by `task:media` to an autoplay audio element. The current SDK requests `{audio: true}`, so audio device choice follows the browser and operating-system defaults.

Webex App setup uses these server-proxied APIs:

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

The interaction header maintains separate timestamps for media and after-call work. `callEndedAt` freezes the displayed call duration when the task enters wrap-up. `wrapupStartedAt` uses the current agent participant's `wrapUpTimestamp` when present, otherwise the observed task event time. Wrap-up therefore starts at `0:00` independently while the completed call duration remains visible.

The selected endpoint is still useful as the user's Webex Calling preference before station login. It is not passed to `task.accept()`; the SDK uses the Webex App device identifiers carried by the offered Contact Center task.

Upstream references:

- [Contact Center SDK introduction](https://developer.webex.com/webex-contact-center/docs/sdks/webex-contact-center-web-sdk-introduction)
- [Contact Center package](https://www.npmjs.com/package/@webex/contact-center)
- [Voice task routing on the upstream next branch](https://github.com/webex/webex-js-sdk/blob/next/packages/%40webex/contact-center/src/services/task/voice/Voice.ts)
- [Task controls and events on the upstream next branch](https://github.com/webex/webex-js-sdk/blob/next/packages/%40webex/contact-center/src/services/task/types.ts)

## Refresh recovery

After successful Contact Center initialization, the browser stores a recovery hint in `sessionStorage` containing only:

- Station login option
- Dial number or extension when applicable
- Selected answer-endpoint metadata for Webex App mode

The access token is not stored in browser storage. On a same-tab refresh:

1. The browser retrieves the current OAuth state and access token from the same-origin server session.
2. The Contact Center SDK initializes with `allowAutomatedRelogin: true`.
3. `cc.register()` attempts the SDK silent relogin.
4. The returned profile is authoritative for station login, team, device type, dial number, and auxiliary state.
5. `task:hydrate` restores an active Contact Center interaction.
6. `task.uiControls` and task events restore the applicable controls and call state.

If no backend station exists, the UI stops at normal station login. Recovery failure displays an error and does not issue a station logout against a possibly valid backend session. Explicit Logout clears the recovery hint.

Recovery requires the Express OAuth session to remain available. The current in-memory session implementation is lost on server restart, redeployment, process replacement, or Render free-tier spin-down.

## Browser call alerts

Alerts default to enabled after sign-in. The OAuth action requests notification permission, and the next explicit initialize or station-login action also prepares alerts when necessary. The Alerts control remains available as an opt-out for the current browser tab and performs two user-authorized operations:

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
- GraphQL agent-performance success or availability outcome
- Contact Center initialization, station login, state, task, recording, transcript lifecycle, consult, conference, transfer, wrap-up, and logout
- SDK task answer, decline, hold, resume, mute, unmute, DTMF, and end outcomes reported through allowlisted non-PII diagnostics

Contact Center SDK actions occur directly in the browser. The browser reports allowlisted lifecycle milestones to `POST /api/diagnostics/events`. The server accepts only known events, outcomes, and fields.

Logs exclude tokens, names, email addresses, phone numbers, endpoint IDs, team IDs, interaction IDs, call IDs, DTMF digits, and destination IDs. A request ID and short SHA-256-derived session reference provide correlation without recording the session cookie.

The Webex browser logger is configured at `error`. Application browser-console output is limited to actionable failures. The in-app diagnostics timeline is separate and may contain interaction-specific identifiers required for live troubleshooting.

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

The free Render tier is unsuitable for an agent session that must remain available because idle spin-down destroys the current in-memory OAuth session. For bounded evaluation, use an always-on single instance or accept that OAuth must be repeated after a process restart. Production requires a durable encrypted session store.

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
- Add rate limits for OAuth, diagnostics, Calling configuration, and reporting proxy routes.
- Validate browser, operating-system, Webex App, endpoint, and tenant compatibility.
- Review npm advisories inherited through the Webex dependency tree and upgrade when remediated packages are available.

## Validation

```bash
npm test
npm run lint
npm run build
```

The test suite covers team normalization, station configuration, custom selectors, native SDK call controls and mute synchronization, call-control state, transcript START/STOP behavior, independent wrap-up timing, idle reasons, refresh recovery, and reporting state isolation.

## Source layout

```text
server.mjs                    OAuth server, Calling and GraphQL proxies, static host, structured logs
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
