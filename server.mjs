import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';

const root = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const viteModule = mode === 'development' ? await import('vite') : undefined;
const fileEnv = viteModule ? viteModule.loadEnv(mode, root, '') : {};
const env = {...fileEnv, ...process.env};
const port = Number(env.PORT || 5173);
const clientId = env.WEBEX_CLIENT_ID || '';
const clientSecret = env.WEBEX_CLIENT_SECRET || '';
const redirectUri = env.WEBEX_REDIRECT_URI || `http://localhost:${port}/api/oauth/callback`;
const scopes =
  env.WEBEX_SCOPES ||
  [
    'spark:telephony_config_read',
    'spark:telephony_config_write',
    'spark:calls_read',
    'spark:calls_write',
    'cjp:user',
    'cjp:config',
    'cjp:config_read',
    'cjp:config_write',
  ].join(' ');
const sessionCookie = 'wxcc_rest_session';
const sessions = new Map();
const oauthAttemptTtlMs = 10 * 60 * 1000;
const sessionIdleTtlMs = 90 * 24 * 60 * 60 * 1000;
let lastSessionPruneAt = 0;

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '32kb'}));
app.use((request, _response, next) => {
  request.requestId = base64url(crypto.randomBytes(9));
  next();
});

function base64url(buffer) {
  return buffer.toString('base64url');
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function setSessionCookie(response, id) {
  const secure = mode === 'production' ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${sessionCookie}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000${secure}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    'Set-Cookie',
    `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${mode === 'production' ? '; Secure' : ''}`,
  );
}

function pruneSessions(now = Date.now()) {
  if (now - lastSessionPruneAt < 5 * 60 * 1000) return;
  lastSessionPruneAt = now;
  for (const [id, session] of sessions) {
    const referenceTime = session.lastSeenAt || session.createdAt || 0;
    const ttl = session.accessToken ? sessionIdleTtlMs : oauthAttemptTtlMs;
    if (now - referenceTime > ttl) sessions.delete(id);
  }
}

function getSession(request) {
  const now = Date.now();
  pruneSessions(now);
  const id = cookieValue(request, sessionCookie);
  const value = id ? sessions.get(id) : undefined;
  if (value) value.lastSeenAt = now;
  return id ? {id, value} : undefined;
}

function sessionReference(request) {
  const id = cookieValue(request, sessionCookie);
  return id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 12) : undefined;
}

function logServer(level, event, request, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(request?.requestId ? {requestId: request.requestId} : {}),
    ...(request ? {sessionRef: sessionReference(request)} : {}),
    ...fields,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.info(output);
}

function safeErrorFields(error) {
  return {
    httpStatus: Number(error?.status) || 502,
    ...(typeof error?.payload?.errorCode === 'string'
      ? {webexErrorCode: error.payload.errorCode.slice(0, 80)}
      : {}),
  };
}

function requireSession(request, response, next) {
  const session = getSession(request);
  if (!session?.value?.accessToken) {
    logServer('warn', 'auth.session_required', request);
    response.status(401).json({message: 'Sign in with Webex first.'});
    return;
  }
  request.webexSession = session;
  next();
}

function requireSameOrigin(request, response, next) {
  const origin = request.headers.origin;
  let validOrigin = true;
  try {
    validOrigin = !origin || new URL(origin).host === request.headers.host;
  } catch {
    validOrigin = false;
  }
  if (!validOrigin) {
    logServer('warn', 'security.origin_rejected', request);
    response.status(403).json({message: 'Cross-origin call-control requests are not allowed.'});
    return;
  }
  next();
}

async function parseWebexResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {message: text};
  }
}

async function refreshAccessToken(session) {
  if (Date.now() < session.expiresAt - 60_000) return session.accessToken;
  if (!session.refreshToken) throw new Error('The Webex session expired. Sign in again.');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: session.refreshToken,
  });
  const response = await fetch('https://webexapis.com/v1/access_token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body,
  });
  const payload = await parseWebexResponse(response);
  if (!response.ok) throw new Error(payload?.message || 'Webex token refresh failed.');
  session.accessToken = payload.access_token;
  session.refreshToken = payload.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + payload.expires_in * 1000;
  return session.accessToken;
}

async function webexRequest(session, apiPath, options = {}) {
  const token = await refreshAccessToken(session);
  const response = await fetch(`https://webexapis.com/v1${apiPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? {'content-type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  const payload = await parseWebexResponse(response);
  if (!response.ok) {
    const error = new Error(payload?.message || `Webex API returned ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const agentPerformanceQuery = `
  query AgentPerformance($from: Long!, $to: Long!, $agentId: String!) {
    taskDetails(
      from: $from
      to: $to
      timeComparator: endedTime
      filter: {
        channelType: { equals: telephony }
        lastAgent: { id: { equals: $agentId } }
      }
      aggregations: [
        { field: "id", type: count, name: "handled" }
        { field: "connectedDuration", type: average, name: "averageConnectedDuration" }
        { field: "holdDuration", type: average, name: "averageHoldDuration" }
        { field: "wrapupDuration", type: average, name: "averageWrapupDuration" }
      ]
    ) {
      tasks {
        aggregation {
          name
          value
        }
      }
    }
  }
`;

function wxccApiOrigin(candidate) {
  try {
    const url = new URL(candidate);
    const productionHost = /^api\.wxcc-[a-z0-9-]+\.cisco\.com$/i.test(url.hostname);
    const nonProductionHosts = new Set([
      'api.intgus1.ciscoccservice.com',
      'api.qaus1.ciscoccservice.com',
      'api.loadus1.cisco.com',
    ]);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (!productionHost && !nonProductionHosts.has(url.hostname.toLowerCase()))
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function reportingWindow(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) return undefined;
  const now = Date.now();
  const maxWindowMs = 27 * 60 * 60 * 1000;
  if (to > now + 60_000 || now - from > 2 * 24 * 60 * 60 * 1000 || to - from > maxWindowMs) {
    return undefined;
  }
  return {from, to};
}

function aggregationValues(payload) {
  const tasks = payload?.data?.taskDetails?.tasks;
  const values = new Map();
  if (!Array.isArray(tasks)) return values;
  for (const task of tasks) {
    if (!Array.isArray(task?.aggregation)) continue;
    for (const aggregation of task.aggregation) {
      if (typeof aggregation?.name !== 'string') continue;
      const value = Number(aggregation.value);
      if (Number.isFinite(value)) values.set(aggregation.name, value);
    }
  }
  return values;
}

function reportingUnavailable(response, reason, message) {
  response.json({available: false, reason, message});
}

function sendApiError(response, error, request, event) {
  logServer('error', event, request, {outcome: 'failed', ...safeErrorFields(error)});
  response.status(error.status || 502).json({
    message: error.message || 'Webex API request failed.',
    details: error.payload,
  });
}

function safeProfileError(error) {
  const status = Number(error?.status) || 0;
  const candidate = error?.payload?.errors?.[0]?.errorCode || error?.payload?.errorCode;
  return {
    status,
    ...(typeof candidate === 'string' && candidate.length <= 80 ? {code: candidate} : {}),
  };
}

// Infrastructure probes intentionally bypass operational logging and OAuth work.
app.get('/healthz', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.status(204).end();
});

async function loadCallingProfile(session, source, request) {
  try {
    const person = await webexRequest(session, '/telephony/config/people/me');
    const displayName =
      person?.displayName ||
      [person?.firstName, person?.lastName].filter(Boolean).join(' ') ||
      person?.name ||
      person?.email ||
      '';
    session.profile = {displayName};
    session.profileLoadedAt = Date.now();
    session.profileError = undefined;
    logServer('info', 'calling.profile', request, {
      outcome: 'succeeded',
      source,
      hasDisplayName: Boolean(displayName),
    });
  } catch (error) {
    session.profile ??= {displayName: ''};
    session.profileError = safeProfileError(error);
    logServer('warn', 'calling.profile', request, {
      outcome: 'failed',
      source,
      httpStatus: session.profileError.status,
      ...(session.profileError.code ? {webexErrorCode: session.profileError.code} : {}),
    });
  }
}

app.get('/api/oauth/status', async (request, response) => {
  const session = getSession(request)?.value;
  const profileIsFresh = session?.profileLoadedAt && Date.now() - session.profileLoadedAt < 5 * 60 * 1000;
  if (session?.accessToken && !profileIsFresh) {
    await loadCallingProfile(session, 'oauth-status', request);
  }
  logServer('info', 'oauth.status', request, {
    authenticated: Boolean(session?.accessToken),
    configured: Boolean(clientId && clientSecret),
  });
  response.setHeader('Cache-Control', 'no-store');
  response.json({
    configured: Boolean(clientId && clientSecret),
    authenticated: Boolean(session?.accessToken),
    accessToken: session?.accessToken || '',
    profile: session?.profile || {displayName: ''},
    profileError: session?.profileError,
  });
});

app.get('/api/oauth/login', (request, response) => {
  if (!clientId || !clientSecret) {
    logServer('error', 'oauth.authorization', request, {outcome: 'failed', reason: 'not_configured'});
    response.status(503).send('WEBEX_CLIENT_ID and WEBEX_CLIENT_SECRET must be configured.');
    return;
  }

  const id = base64url(crypto.randomBytes(32));
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  sessions.set(id, {state, verifier, createdAt: Date.now(), lastSeenAt: Date.now()});
  setSessionCookie(response, id);
  logServer('info', 'oauth.authorization', request, {outcome: 'started'});

  const authorize = new URL('https://webexapis.com/v1/authorize');
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  response.redirect(authorize.toString());
});

app.get('/api/oauth/callback', async (request, response) => {
  const session = getSession(request);
  if (!session?.value || !request.query.code || request.query.state !== session.value.state) {
    logServer('warn', 'oauth.callback', request, {outcome: 'failed', reason: 'validation'});
    response.status(400).send('The OAuth response could not be validated. Start the sign-in flow again.');
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: String(request.query.code),
      code_verifier: session.value.verifier,
    });
    const tokenResponse = await fetch('https://webexapis.com/v1/access_token', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body,
    });
    const token = await parseWebexResponse(tokenResponse);
    if (!tokenResponse.ok) throw new Error(token?.message || 'OAuth token exchange failed.');

    Object.assign(session.value, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      state: undefined,
      verifier: undefined,
    });
    session.value.profile = {displayName: ''};
    session.value.profileLoadedAt = undefined;
    session.value.profileError = undefined;
    logServer('info', 'oauth.callback', request, {outcome: 'succeeded'});
    response.redirect('/?oauth=success');
  } catch (error) {
    logServer('error', 'oauth.callback', request, {
      outcome: 'failed',
      reason: 'token_exchange',
    });
    response.status(502).send(error instanceof Error ? error.message : 'OAuth callback failed.');
  }
});

app.post('/api/oauth/logout', requireSameOrigin, (request, response) => {
  const session = getSession(request);
  if (session) sessions.delete(session.id);
  logServer('info', 'oauth.logout', request, {outcome: 'succeeded', hadSession: Boolean(session)});
  clearSessionCookie(response);
  response.status(204).end();
});

app.get('/api/calling/station-configuration', requireSession, async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    const [extensions, preferred, availablePayload] = await Promise.all([
      webexRequest(
        request.webexSession.value,
        '/telephony/config/people/me/settings/contactCenterExtensions',
      ),
      webexRequest(
        request.webexSession.value,
        '/telephony/config/people/me/settings/preferredAnswerEndpoint',
      ),
      webexRequest(
        request.webexSession.value,
        '/telephony/config/people/me/settings/availablePreferredAnswerEndpoints',
      ),
    ]);
    const available = Array.isArray(availablePayload)
      ? availablePayload
      : availablePayload?.endpoints ?? [];
    const preferredId = preferred?.id || preferred?.preferredAnswerEndpointId || '';
    const preferredDetail = available.find((endpoint) => endpoint.id === preferredId);
    response.json({
      extensions,
      preferred: preferredId
        ? {id: preferredId, ...preferredDetail, ...preferred}
        : undefined,
      available,
    });
    logServer('info', 'calling.station_configuration', request, {
      outcome: 'succeeded',
      extensionCount: extensions?.ccExtensions?.length || 0,
      endpointCount: available.length,
      hasPreferredEndpoint: Boolean(preferredId),
    });
  } catch (error) {
    sendApiError(response, error, request, 'calling.station_configuration');
  }
});

app.put(
  '/api/calling/preferred-endpoint',
  requireSameOrigin,
  requireSession,
  async (request, response) => {
    const endpointId = request.body?.endpointId;
    if (endpointId !== null && (typeof endpointId !== 'string' || !endpointId)) {
      response.status(400).json({message: 'endpointId must be a non-empty string or null.'});
      return;
    }
    try {
      await webexRequest(
        request.webexSession.value,
        '/telephony/config/people/me/settings/preferredAnswerEndpoint',
        {method: 'PUT', body: JSON.stringify({id: endpointId})},
      );
      logServer('info', 'calling.preferred_endpoint_update', request, {
        outcome: 'succeeded',
        preferenceCleared: endpointId === null,
      });
      response.status(204).end();
    } catch (error) {
      sendApiError(response, error, request, 'calling.preferred_endpoint_update');
    }
  },
);

app.post(
  '/api/reporting/agent-performance',
  requireSameOrigin,
  requireSession,
  async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const agentId = typeof request.body?.agentId === 'string' ? request.body.agentId.trim() : '';
    const apiOrigin = wxccApiOrigin(request.body?.apiBaseUrl);
    const window = reportingWindow(request.body?.from, request.body?.to);
    if (!apiOrigin || !agentId || agentId.length > 160 || !window) {
      response.status(400).json({message: 'Invalid reporting request.'});
      return;
    }

    try {
      const accessToken = await refreshAccessToken(request.webexSession.value);
      const searchResponse = await fetch(`${apiOrigin}/search`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: agentPerformanceQuery,
          variables: {...window, agentId},
        }),
      });
      const payload = await parseWebexResponse(searchResponse);

      if (searchResponse.status === 401 || searchResponse.status === 403) {
        logServer('warn', 'reporting.agent_performance', request, {
          outcome: 'unavailable',
          reason: 'authorization',
          httpStatus: searchResponse.status,
        });
        reportingUnavailable(
          response,
          'authorization',
          'Performance statistics require a Contact Center Administrator or Supervisor role.',
        );
        return;
      }
      if (!searchResponse.ok) {
        const error = new Error(payload?.message || `Webex Search returned ${searchResponse.status}.`);
        error.status = searchResponse.status;
        error.payload = payload;
        throw error;
      }
      if (Array.isArray(payload?.errors) && payload.errors.length) {
        const authorizationError = payload.errors.some((entry) => {
          const code = String(entry?.extensions?.code || '').toUpperCase();
          const message = String(entry?.message || '').toLowerCase();
          return (
            ['UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN', 'AUTHORIZATION_ERROR'].includes(code) ||
            message.includes('unauthorized') ||
            message.includes('forbidden') ||
            message.includes('not authorized')
          );
        });
        logServer('warn', 'reporting.agent_performance', request, {
          outcome: 'unavailable',
          reason: authorizationError ? 'authorization' : 'query_rejected',
        });
        reportingUnavailable(
          response,
          authorizationError ? 'authorization' : 'query-rejected',
          authorizationError
            ? 'Performance statistics require a Contact Center Administrator or Supervisor role.'
            : 'Performance statistics are not available from this tenant reporting schema.',
        );
        return;
      }

      const values = aggregationValues(payload);
      const millisecondsToSeconds = (value) => Math.max(0, value || 0) / 1000;
      const performance = {
        source: 'graphql-search',
        ...window,
        handled: Math.max(0, Math.round(values.get('handled') || 0)),
        averageConnectedSeconds: millisecondsToSeconds(values.get('averageConnectedDuration')),
        averageHoldSeconds: millisecondsToSeconds(values.get('averageHoldDuration')),
        averageWrapupSeconds: millisecondsToSeconds(values.get('averageWrapupDuration')),
      };
      response.json({available: true, performance});
      logServer('info', 'reporting.agent_performance', request, {
        outcome: 'succeeded',
        metricCount: values.size,
      });
    } catch (error) {
      sendApiError(response, error, request, 'reporting.agent_performance');
    }
  },
);

const diagnosticEvents = new Set([
  'cc.initialize',
  'cc.station_login',
  'cc.agent_state',
  'cc.task',
  'cc.webex_call_control',
  'cc.recording',
  'cc.consult',
  'cc.transfer',
  'cc.consult_transfer',
  'cc.consult_end',
  'cc.consult_switch',
  'cc.conference',
  'cc.conference_participant',
  'cc.ai_assistance',
  'cc.ai_feedback',
  'cc.ai_summary',
  'cc.wrapup',
  'cc.logout',
]);
const diagnosticOutcomes = new Set(['started', 'succeeded', 'failed', 'observed']);
const diagnosticStates = new Set(['available', 'idle', 'ringing', 'connected', 'held', 'wrap-up', 'ended']);

app.post('/api/diagnostics/events', requireSameOrigin, requireSession, (request, response) => {
  const {event, outcome, details = {}} = request.body || {};
  if (!diagnosticEvents.has(event) || !diagnosticOutcomes.has(outcome)) {
    response.status(400).json({message: 'Unsupported diagnostic event.'});
    return;
  }
  const safeDetails = {};
  if (typeof details.hasAnswerEndpoint === 'boolean') {
    safeDetails.hasAnswerEndpoint = details.hasAnswerEndpoint;
  }
  if (typeof details.stationRecovered === 'boolean') {
    safeDetails.stationRecovered = details.stationRecovered;
  }
  if (Number.isInteger(details.taskCount) && details.taskCount >= 0 && details.taskCount <= 100) {
    safeDetails.taskCount = details.taskCount;
  }
  if (diagnosticStates.has(details.state)) safeDetails.state = details.state;
  if (['BROWSER', 'EXTENSION', 'AGENT_DN'].includes(details.deviceType)) {
    safeDetails.deviceType = details.deviceType;
  }
  if (['pause', 'resume', 'start', 'exit', 'accept', 'decline', 'mute', 'unmute', 'dtmf', 'hold', 'end', 'mid-call', 'post-call', 'drop', 'transfer', 'likeButton', 'dislikeButton', 'copyButton'].includes(details.action)) {
    safeDetails.action = details.action;
  }
  if (['agent', 'queue'].includes(details.destinationType)) {
    safeDetails.destinationType = details.destinationType;
  }
  logServer(outcome === 'failed' ? 'error' : 'info', event, request, {outcome, ...safeDetails});
  response.status(204).end();
});

if (mode === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('*splat', (_request, response) => response.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const vite = await viteModule.createServer({root, server: {middlewareMode: true}, appType: 'spa'});
  app.use(vite.middlewares);
}

app.listen(port, '0.0.0.0', () => {
  logServer('info', 'server.started', undefined, {port, mode});
});
