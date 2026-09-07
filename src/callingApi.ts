export interface OAuthStatus {
  configured: boolean;
  authenticated: boolean;
  accessToken: string;
  profile: {
    displayName: string;
  };
  profileError?: {
    status: number;
    code?: string;
  };
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

export function getStationConfiguration(): Promise<StationConfigurationResponse> {
  return requestJson<StationConfigurationResponse>('/api/calling/station-configuration');
}

export function setPreferredAnswerEndpoint(endpointId: string | null): Promise<void> {
  return requestJson<void>('/api/calling/preferred-endpoint', {
    method: 'PUT',
    body: JSON.stringify({endpointId}),
  });
}
