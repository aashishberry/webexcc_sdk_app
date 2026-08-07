import type {
  AnswerEndpoint,
  ContactCenterExtension,
  StationConfigurationResponse,
} from './callingApi';

export function stationValue(extension: ContactCenterExtension): string {
  return extension.extension || extension.directNumber || '';
}

export function configuredExtensions(
  configuration?: StationConfigurationResponse,
): ContactCenterExtension[] {
  return Array.from(
    new Map(
      (configuration?.extensions.ccExtensions ?? [])
        .map((extension) => [stationValue(extension), extension] as const)
        .filter(([value]) => Boolean(value)),
    ).values(),
  );
}

export function endpointsForExtension(
  configuration: StationConfigurationResponse | undefined,
  extension: ContactCenterExtension | undefined,
): AnswerEndpoint[] {
  if (!configuration) return [];
  const associatedIds = new Set(
    extension?.endpoints?.map((endpoint) => endpoint.id).filter(Boolean) as string[] | undefined,
  );
  const available = associatedIds.size
    ? configuration.available.filter((endpoint) => associatedIds.has(endpoint.id))
    : configuration.available;
  const details = new Map(
    (configuration.extensions.endpoints ?? [])
      .filter((endpoint) => endpoint.id)
      .map((endpoint) => [endpoint.id, endpoint]),
  );
  return available.map((endpoint) => {
    const detail = details.get(endpoint.id);
    return {
      ...endpoint,
      name: endpoint.name || detail?.name,
      status: detail?.status || endpoint.status,
    };
  });
}

export function defaultEndpointId(
  configuration: StationConfigurationResponse | undefined,
  extension: ContactCenterExtension | undefined,
): string {
  const candidates = endpointsForExtension(configuration, extension);
  const usable = candidates.filter((endpoint) => endpoint.status !== 'NOT_CONNECTED');
  const preferredIds = [
    configuration?.preferred?.id,
    extension?.preferredAnsweringEndPointId,
  ].filter(Boolean);
  const preferred = usable.find((endpoint) => preferredIds.includes(endpoint.id));
  if (preferred) return preferred.id;

  const connectedApplications = usable.filter(
    (endpoint) => endpoint.type === 'APPLICATION' && endpoint.status === 'CONNECTED',
  );
  if (connectedApplications.length === 1) return connectedApplications[0].id;
  if (usable.length === 1) return usable[0].id;
  return '';
}
