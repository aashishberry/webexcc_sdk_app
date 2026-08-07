import {describe, expect, it} from 'vitest';
import type {StationConfigurationResponse} from './callingApi';
import {
  configuredExtensions,
  defaultEndpointId,
  endpointsForExtension,
} from './stationConfiguration';

const configuration: StationConfigurationResponse = {
  extensions: {
    ccExtensions: [
      {
        extension: '4102',
        type: 'PRIMARY',
        preferredAnsweringEndPointId: 'app-1',
        endpoints: [{id: 'app-1'}, {id: 'phone-1'}],
      },
      {extension: '4103', type: 'SECONDARY', endpoints: [{id: 'app-2'}]},
    ],
    endpoints: [
      {id: 'app-1', name: 'Webex App', status: 'CONNECTED'},
      {id: 'phone-1', name: 'Desk phone', status: 'CONNECTED'},
      {id: 'app-2', name: 'Other app', status: 'NOT_CONNECTED'},
    ],
  },
  preferred: {id: 'app-1', name: 'Webex App', type: 'APPLICATION'},
  available: [
    {id: 'app-1', name: 'Webex App', type: 'APPLICATION'},
    {id: 'phone-1', name: 'Desk phone', type: 'DEVICE'},
    {id: 'app-2', name: 'Other app', type: 'APPLICATION'},
  ],
};

describe('station configuration', () => {
  it('returns endpoints eligible for the selected extension with registration details', () => {
    const extension = configuredExtensions(configuration)[0];

    expect(endpointsForExtension(configuration, extension)).toEqual([
      {id: 'app-1', name: 'Webex App', type: 'APPLICATION', status: 'CONNECTED'},
      {id: 'phone-1', name: 'Desk phone', type: 'DEVICE', status: 'CONNECTED'},
    ]);
  });

  it('selects the existing preferred endpoint', () => {
    const extension = configuredExtensions(configuration)[0];
    expect(defaultEndpointId(configuration, extension)).toBe('app-1');
  });

  it('does not automatically select an unregistered endpoint', () => {
    const extension = configuredExtensions(configuration)[1];
    expect(defaultEndpointId(configuration, extension)).toBe('');
  });
});
