export type CallingState =
  | 'connecting'
  | 'alerting'
  | 'connected'
  | 'held'
  | 'remoteHeld'
  | 'disconnected';

export interface CallingParty {
  name?: string;
  number?: string;
  privacyEnabled?: boolean;
}

export interface CallingRestCall {
  id?: string;
  callId?: string;
  callSessionId?: string;
  personality?: 'originator' | 'terminator' | 'clickToDial';
  state?: CallingState;
  remoteParty?: CallingParty;
  endpointId?: string;
  endpointType?: string;
  created?: string;
  muteCapable?: boolean;
  muted?: boolean;
}

export interface OAuthStatus {
  configured: boolean;
  authenticated: boolean;
  accessToken: string;
  profile: {
    displayName: string;
    email: string;
  };
  profileError?: {
    status: number;
    code?: string;
  };
  profileLookup: {
    attempted: boolean;
    ok: boolean;
    hasDisplayName?: boolean;
    hasEmail?: boolean;
  };
  profileMappingVersion: number;
  scopes: string;
}

export interface ContactCenterExtension {
  directNumber?: string;
  extension?: string;
  type?: 'PRIMARY' | 'SECONDARY' | string;
  lineOwnerType?: string;
  lineOwnerId?: string;
  preferredAnsweringEndPointId?: string;
  endpoints?: Array<{id?: string; type?: string}>;
}

export interface ContactCenterEndpoint {
  id?: string;
  type?: string;
  name?: string;
  status?: 'CONNECTED' | 'NOT_CONNECTED' | string;
}

export interface ContactCenterExtensionsResponse {
  ccExtensions?: ContactCenterExtension[];
  endpoints?: ContactCenterEndpoint[];
}

export interface AnswerEndpoint {
  id: string;
  name?: string;
  type?: 'APPLICATION' | 'DEVICE';
  status?: 'CONNECTED' | 'NOT_CONNECTED' | string;
}

export interface PreferredEndpointResponse {
  preferred?: AnswerEndpoint & {preferredAnswerEndpointId?: string};
  available?: {endpoints?: AnswerEndpoint[]} | AnswerEndpoint[];
}

export interface StationConfigurationResponse {
  extensions: ContactCenterExtensionsResponse;
  preferred?: AnswerEndpoint;
  available: AnswerEndpoint[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? {'content-type': 'application/json'} : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Request failed with ${response.status}.`);
  return payload as T;
}

export function getOAuthStatus(): Promise<OAuthStatus> {
  return requestJson<OAuthStatus>('/api/oauth/status');
}

export function logoutOAuth(): Promise<void> {
  return requestJson<void>('/api/oauth/logout', {method: 'POST'});
}

export function getContactCenterExtensions(): Promise<ContactCenterExtensionsResponse> {
  return requestJson<ContactCenterExtensionsResponse>('/api/calling/contact-center-extensions');
}

export function getStationConfiguration(): Promise<StationConfigurationResponse> {
  return requestJson<StationConfigurationResponse>('/api/calling/station-configuration');
}

export function setPreferredAnswerEndpoint(endpointId: string | null): Promise<void> {
  return requestJson<void>('/api/calling/preferred-endpoint', {
    method: 'PUT',
    body: JSON.stringify({endpointId}),
  });
}

export class CallingApiClient {
  async listCalls(): Promise<CallingRestCall[]> {
    const payload = await requestJson<CallingRestCall[] | {items?: CallingRestCall[]}>(
      '/api/calling/calls',
    );
    if (Array.isArray(payload)) return payload;
    return payload.items ?? [];
  }

  getPreferredEndpoint(): Promise<PreferredEndpointResponse> {
    return requestJson<PreferredEndpointResponse>('/api/calling/preferred-endpoint');
  }

  action(
    action: 'answer' | 'hangup' | 'hold' | 'resume' | 'mute' | 'unmute' | 'transmitDtmf',
    payload: {callId: string; endpointId?: string; dtmf?: string},
  ): Promise<void> {
    return requestJson<void>(`/api/calling/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}
