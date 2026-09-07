import {afterEach, describe, expect, it, vi} from 'vitest';
import {getAgentPerformance} from './callingApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAgentPerformance', () => {
  it('posts the reporting window through the same-origin server route', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          available: true,
          performance: {
            source: 'graphql-search',
            from: 100,
            to: 200,
            handled: 3,
            averageConnectedSeconds: 45,
            averageHoldSeconds: 2,
            averageWrapupSeconds: 8,
          },
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await getAgentPerformance({
      apiBaseUrl: 'https://api.wxcc-us1.cisco.com',
      agentId: 'agent-1',
      from: 100,
      to: 200,
    });

    expect(response).toMatchObject({available: true, performance: {handled: 3}});
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reporting/agent-performance',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({
          apiBaseUrl: 'https://api.wxcc-us1.cisco.com',
          agentId: 'agent-1',
          from: 100,
          to: 200,
        }),
      }),
    );
  });
});
