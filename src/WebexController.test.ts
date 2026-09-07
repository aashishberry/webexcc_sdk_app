import {describe, expect, it, vi} from 'vitest';
import type {ITask, Profile} from '@webex/contact-center';
import {WebexController} from './WebexController';

const {getAgentPerformanceMock} = vi.hoisted(() => ({
  getAgentPerformanceMock: vi.fn(),
}));

vi.mock('@webex/contact-center', () => ({default: {}}));
vi.mock('./callingApi', () => ({getAgentPerformance: getAgentPerformanceMock}));

type TaskListener = (...args: any[]) => void;

type FakeTask = ITask & {
  emitTest: (event: string, payload?: unknown) => void;
  accept: ReturnType<typeof vi.fn>;
  decline: ReturnType<typeof vi.fn>;
  hold: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  consult: ReturnType<typeof vi.fn>;
  endConsult: ReturnType<typeof vi.fn>;
  toggleMute: ReturnType<typeof vi.fn>;
  transmitDtmf: ReturnType<typeof vi.fn>;
};

function fakeTask(wrapUpRequired: boolean): FakeTask {
  const listeners = new Map<string, TaskListener[]>();
  let muted = false;
  const task = {
    data: {interactionId: 'interaction-1', wrapUpRequired},
    uiControls: {
      main: {
        accept: {isVisible: true, isEnabled: true},
        decline: {isVisible: true, isEnabled: true},
        hold: {isVisible: true, isEnabled: true},
        end: {isVisible: true, isEnabled: true},
        mute: {isVisible: true, isEnabled: true},
        keypad: {isVisible: true, isEnabled: true},
      },
    },
    accept: vi.fn(async () => undefined),
    decline: vi.fn(async () => undefined),
    hold: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    consult: vi.fn(async () => undefined),
    endConsult: vi.fn(async () => undefined),
    toggleMute: vi.fn(async ({muted: target}: {muted: boolean}) => {
      muted = target;
    }),
    transmitDtmf: vi.fn(async () => undefined),
    getWxAppMuted: () => muted,
    on(event: string, listener: TaskListener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return task;
    },
    emitTest(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload ?? (task as unknown as ITask));
      }
    },
  };
  return task as unknown as FakeTask;
}

function observeTask(controller: WebexController, task: ITask): void {
  const internal = controller as unknown as {attachTaskListeners: (candidate: ITask) => void};
  internal.attachTaskListeners(task);
}

describe('WebexController performance', () => {
  it('loads current-day statistics from the SDK-discovered regional service', async () => {
    getAgentPerformanceMock.mockResolvedValueOnce({
      available: true,
      performance: {
        source: 'graphql-search',
        from: 1,
        to: 2,
        handled: 7,
        averageConnectedSeconds: 81,
        averageHoldSeconds: 9,
        averageWrapupSeconds: 14,
      },
    });
    const controller = new WebexController();
    const serviceGet = vi.fn(() => 'https://api.wxcc-us1.cisco.com/v1');
    const internal = controller as unknown as {
      webex: {internal: {services: {get: typeof serviceGet}}};
      profile: Profile;
    };
    internal.webex = {internal: {services: {get: serviceGet}}};
    internal.profile = {agentId: 'agent-1'} as Profile;

    await controller.loadPerformance();

    expect(serviceGet).toHaveBeenCalledWith('wcc-api-gateway');
    expect(getAgentPerformanceMock).toHaveBeenCalledWith({
      apiBaseUrl: 'https://api.wxcc-us1.cisco.com/v1',
      agentId: 'agent-1',
      from: expect.any(Number),
      to: expect.any(Number),
    });
    expect(controller.getSnapshot()).toMatchObject({
      performanceStatus: 'ready',
      performance: {handled: 7, averageConnectedSeconds: 81},
    });
  });

  it('keeps reporting authorization failures separate from lifecycle errors', async () => {
    getAgentPerformanceMock.mockResolvedValueOnce({
      available: false,
      reason: 'authorization',
      message: 'Performance statistics require a Supervisor role.',
    });
    const controller = new WebexController();
    const internal = controller as unknown as {
      webex: {internal: {services: {get: () => string}}};
      profile: Profile;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.webex = {
      internal: {services: {get: () => 'https://api.wxcc-eu1.cisco.com'}},
    };
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.update({lifecycle: 'available'});

    await controller.loadPerformance();

    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: 'available',
      performanceStatus: 'unavailable',
      performanceMessage: 'Performance statistics require a Supervisor role.',
      error: '',
    });
  });

  it('refreshes performance after a completed interaction returns to the home view', async () => {
    vi.useFakeTimers();
    getAgentPerformanceMock.mockClear();
    getAgentPerformanceMock.mockResolvedValue({
      available: true,
      performance: {
        source: 'graphql-search',
        from: 1,
        to: 2,
        handled: 8,
        averageConnectedSeconds: 80,
        averageHoldSeconds: 8,
        averageWrapupSeconds: 12,
      },
    });
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      webex: {internal: {services: {get: () => string}}};
      profile: Profile;
      task: ITask;
    };
    internal.webex = {
      internal: {services: {get: () => 'https://api.wxcc-us1.cisco.com'}},
    };
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('task:end');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getAgentPerformanceMock).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().performance?.handled).toBe(8);
    vi.useRealTimers();
  });
});

describe('WebexController station login', () => {
  it.each([
    ['EXTENSION', '4093'],
    ['AGENT_DN', '+14085550100'],
  ] as const)('passes %s and its dial number to the SDK', async (loginOption, dialNumber) => {
    const controller = new WebexController();
    const stationLogin = vi.fn(async () => ({dn: dialNumber}));
    const internal = controller as unknown as {
      cc: {stationLogin: typeof stationLogin};
      profile: Profile;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.cc = {stationLogin};
    internal.profile = {} as Profile;
    internal.update({
      selectedTeamId: 'team-1',
      loginVoiceOptions: ['EXTENSION', 'AGENT_DN'],
    });

    await controller.stationLogin({loginOption, dialNumber});

    expect(stationLogin).toHaveBeenCalledWith({
      teamId: 'team-1',
      loginOption,
      dialNumber,
    });
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: 'station-logged-in',
      stationLoginOption: loginOption,
      stationDialNumber: dialNumber,
    });
  });

  it('logs in with browser audio without sending a dial number', async () => {
    const controller = new WebexController();
    const stationLogin = vi.fn(async () => ({deviceType: 'BROWSER'}));
    const internal = controller as unknown as {
      cc: {stationLogin: typeof stationLogin};
      profile: Profile;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.cc = {stationLogin};
    internal.profile = {} as Profile;
    internal.update({
      selectedTeamId: 'team-1',
      loginVoiceOptions: ['BROWSER'],
      webRtcEnabled: true,
    });

    await controller.stationLogin({loginOption: 'BROWSER'});

    expect(stationLogin).toHaveBeenCalledWith({
      teamId: 'team-1',
      loginOption: 'BROWSER',
    });
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: 'station-logged-in',
      stationLoginOption: 'BROWSER',
      stationDialNumber: '',
      endpointName: 'This browser',
    });
  });
});

describe('WebexController task completion', () => {
  it('ends the ringing presentation and enters RONA when an offer is rejected by routing', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({
      activeTask: task,
      callStatus: 'ringing',
      callStartedAt: Date.now() - 15_000,
      acceptCapable: true,
      declineCapable: true,
    });
    observeTask(controller, task);

    task.emitTest('task:rejected', 'NO_ANSWER');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'rona',
      agentState: 'RONA',
      lifecycle: 'idle',
      callEndedAt: expect.any(Number),
      acceptCapable: false,
      declineCapable: false,
    });
  });

  it('ends only the consultation when its destination does not answer', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({
      activeTask: task,
      callStatus: 'connected',
      consultActive: true,
      consultDestinationName: 'Agent Two',
    });
    observeTask(controller, task);

    task.emitTest('task:rejected', 'NO_ANSWER');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'connected',
      consultActive: false,
      consultStatus: 'none',
      consultDestinationName: '',
    });
  });

  it('replaces the consult offer controls when the consulted agent connects', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    (task.uiControls as any).activeLeg = 'main';
    (task.uiControls as any).main.accept = {isVisible: false, isEnabled: false};
    (task.uiControls as any).main.decline = {isVisible: false, isEnabled: false};
    Object.assign((task.data as any), {
      isConsulted: true,
      interaction: {
        state: 'consulting',
        mainInteractionId: 'interaction-1',
        media: {'interaction-1': {mediaResourceId: 'interaction-1', isHold: false}},
      },
    });
    internal.update({
      activeTask: task,
      callStatus: 'ringing',
      acceptCapable: true,
      declineCapable: true,
    });
    observeTask(controller, task);

    task.emitTest('task:consultAccepted');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'connected',
      consultActive: true,
      consultStatus: 'connected',
      held: false,
      acceptCapable: false,
      declineCapable: false,
    });
  });

  it('restores the held main leg after a consultation ends', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    (task.uiControls as any).activeLeg = 'consult';
    (task.uiControls as any).consult = {
      ...((task.uiControls as any).main),
      hold: {isVisible: false, isEnabled: false},
    };
    (task.uiControls as any).main.hold = {isVisible: true, isEnabled: true};
    Object.assign((task.data as any), {
      consultMediaResourceId: 'consult-1',
      interaction: {
        state: 'hold',
        mainInteractionId: 'interaction-1',
        media: {
          'interaction-1': {mediaResourceId: 'interaction-1', mType: 'mainCall', isHold: true},
          'consult-1': {mediaResourceId: 'consult-1', mType: 'consult', isHold: false},
        },
      },
    });
    internal.update({
      activeTask: task,
      callStatus: 'connected',
      consultActive: true,
      consultDestinationName: 'Agent Two',
      held: false,
    });
    observeTask(controller, task);

    task.emitTest('task:consultEnd');
    (task.uiControls as any).activeLeg = 'main';
    task.emitTest('task:ui-controls-updated');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'held',
      consultActive: false,
      consultStatus: 'none',
      consultDestinationName: '',
      held: true,
      holdCapable: true,
    });
  });

  it('derives participant labels and hold state from the switched media leg', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      profile: Profile;
    };
    internal.task = task;
    internal.profile = {agentId: 'agent-1'} as Profile;
    (task.uiControls as any).activeLeg = 'main';
    (task.uiControls as any).consult = {...(task.uiControls as any).main};
    Object.assign((task.data as any), {
      agentId: 'agent-1',
      consultMediaResourceId: 'consult-1',
      interaction: {
        owner: 'agent-1',
        mainInteractionId: 'interaction-1',
        callProcessingDetails: {ani: '+14085550123', customerName: 'Caller One'},
        participants: {
          'agent-1': {id: 'agent-1', pType: 'Agent', name: 'Agent One', hasJoined: true},
          'customer-1': {id: 'customer-1', dn: '+14085550123', hasJoined: true, currentState: 'hold'},
          'agent-2': {id: 'agent-2', pType: 'Agent', name: 'Agent Two', hasJoined: true},
        },
        media: {
          'interaction-1': {
            mediaResourceId: 'interaction-1',
            mType: 'mainCall',
            participants: ['agent-1', 'customer-1'],
            isHold: false,
          },
          'consult-1': {
            mediaResourceId: 'consult-1',
            mType: 'consult',
            participants: ['agent-1', 'agent-2'],
            isHold: true,
          },
        },
      },
    });
    observeTask(controller, task);

    task.emitTest('task:switchCall');

    expect(controller.getSnapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'customer-1', name: 'Caller One', type: 'Customer', state: 'Connected', held: false}),
      expect.objectContaining({id: 'agent-2', type: 'Agent', state: 'Held', held: true}),
    ]));

    (task.uiControls as any).activeLeg = 'consult';
    (task.data as any).interaction.media['interaction-1'].isHold = true;
    (task.data as any).interaction.media['consult-1'].isHold = false;
    task.emitTest('task:switchCall');

    expect(controller.getSnapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'customer-1', state: 'Held', held: true}),
      expect.objectContaining({id: 'agent-2', state: 'Connected', held: false}),
    ]));
  });

  it('retains a disconnected customer after a conference participant-left snapshot', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      profile: Profile;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.update({conferenceActive: true, callStatus: 'connected'});
    Object.assign((task.data as any), {
      agentId: 'agent-1',
      eventType: 'ParticipantJoinedConference',
      interaction: {
        owner: 'agent-1',
        state: 'conference',
        mainInteractionId: 'interaction-1',
        participants: {
          'agent-1': {id: 'agent-1', pType: 'Agent', name: 'Agent One', hasJoined: true},
          'agent-2': {id: 'agent-2', pType: 'Agent', name: 'Agent Two', hasJoined: true},
          'customer-1': {id: 'customer-1', pType: 'Customer', name: 'Caller One', hasJoined: true},
        },
        media: {
          'interaction-1': {
            mediaResourceId: 'interaction-1',
            mType: 'mainCall',
            participants: ['agent-1', 'agent-2', 'customer-1'],
            isHold: false,
          },
        },
      },
    });
    observeTask(controller, task);
    task.emitTest('task:participantJoined');

    expect(controller.getSnapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'customer-1', state: 'Connected'}),
    ]));

    (task.data as any).eventType = 'ParticipantLeftConference';
    (task.data as any).participantId = 'customer-1';
    delete (task.data as any).interaction.participants['customer-1'];
    (task.data as any).interaction.media['interaction-1'].participants = ['agent-1', 'agent-2'];
    task.emitTest('task:participantLeft');

    expect(controller.getSnapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'customer-1',
        name: 'Caller One',
        type: 'Customer',
        state: 'Disconnected',
        held: false,
      }),
    ]));

    (task.data as any).eventType = 'ContactUpdated';
    (task.data as any).participantId = 'agent-3';
    (task.data as any).interaction.participants['customer-1'] = {
      id: 'customer-1',
      pType: 'Customer',
      name: 'Caller One',
      hasJoined: true,
      hasLeft: false,
    };
    task.emitTest('task:ui-controls-updated');

    expect(controller.getSnapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'customer-1', state: 'Disconnected'}),
    ]));
  });

  it('enables wrap-up when task:end reports wrapUpRequired', () => {
    const controller = new WebexController();
    const task = fakeTask(true);

    observeTask(controller, task);
    task.emitTest('task:end');

    expect(controller.getSnapshot().callStatus).toBe('wrap-up');
    expect(controller.getSnapshot().activeTask).toBe(task);
  });

  it('clears a completed task when task:end does not require wrap-up', () => {
    const controller = new WebexController();
    const task = fakeTask(false);

    observeTask(controller, task);
    task.emitTest('task:end');

    expect(controller.getSnapshot().callStatus).toBe('none');
    expect(controller.getSnapshot().activeTask).toBeUndefined();
  });

  it('uses the Contact Center task end event to enter wrap-up', async () => {
    const controller = new WebexController();
    const task = fakeTask(true);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    observeTask(controller, task);
    internal.update({callStatus: 'connected', endCapable: true, activeTask: task});
    task.end.mockImplementation(async () => task.emitTest('task:end'));

    await controller.endCall();

    expect(task.end).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'wrap-up',
      callEndedAt: expect.any(Number),
      wrapupStartedAt: expect.any(Number),
    });
    expect(controller.getSnapshot().callEndedAt).toBeGreaterThan(0);
    expect(controller.getSnapshot().wrapupStartedAt).toBeGreaterThan(0);
  });
});

describe('WebexController interaction timing', () => {
  it('freezes queue wait at offer time and starts call duration when the agent joins', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const queuedAt = 1_788_790_000_000;
    const offeredAt = queuedAt + 35_000;
    const connectedAt = offeredAt + 8_000;
    const listeners = new Map<string, (payload: ITask) => void>();
    const internal = controller as unknown as {
      cc: {on: (event: string, listener: (payload: ITask) => void) => void};
      profile: Profile;
      attachContactCenterListeners: () => void;
    };
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.cc = {
      on: (event, listener) => listeners.set(event, listener),
    };
    Object.assign((task as any).data, {
      agentId: 'agent-1',
      eventTime: offeredAt,
      interaction: {
        queuedTimestamp: queuedAt,
        participants: {
          'agent-1': {id: 'agent-1', hasJoined: false},
        },
      },
    });
    internal.attachContactCenterListeners();

    listeners.get('task:incoming')?.(task);

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'ringing',
      callStartedAt: offeredAt,
      queueDurationMs: 35_000,
    });

    (task.data as any).eventTime = connectedAt;
    (task.data as any).interaction.participants['agent-1'] = {
      id: 'agent-1',
      hasJoined: true,
      joinTimestamp: connectedAt,
    };
    task.emitTest('task:assigned');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'connected',
      callStartedAt: connectedAt,
      queueDurationMs: 35_000,
    });
  });

  it('restores ended call and wrap-up timing from backend timestamps instead of refresh time', () => {
    const controller = new WebexController();
    const task = fakeTask(true);
    const assignedAt = 1_788_790_043_000;
    const endedAt = assignedAt + 125_000;
    Object.assign((task as any).data, {
      agentId: 'agent-1',
      eventTime: endedAt,
      interaction: {
        state: 'connected',
        isTerminated: true,
        participants: {
          'agent-1': {
            id: 'agent-1',
            hasJoined: true,
            isWrapUp: true,
            joinTimestamp: assignedAt,
          },
        },
      },
    });
    const internal = controller as unknown as {
      profile: Profile;
      restoreHydratedTask: (candidate: ITask) => void;
    };
    internal.profile = {agentId: 'agent-1'} as Profile;

    internal.restoreHydratedTask(task);

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'wrap-up',
      callStartedAt: assignedAt,
      callEndedAt: endedAt,
      wrapupStartedAt: endedAt,
    });
  });
});

describe('WebexController transcription', () => {
  it('explicitly starts transcript streaming when an enabled task is assigned', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const sendEvent = vi.fn(async () => ({}));
    const internal = controller as unknown as {
      cc: {apiAIAssistant: {sendEvent: typeof sendEvent}};
      profile: Profile;
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.cc = {apiAIAssistant: {sendEvent}};
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.task = task;
    internal.update({
      realtimeTranscriptionEnabled: true,
      transcriptionStatus: 'waiting',
    });
    observeTask(controller, task);

    task.emitTest('task:assigned');

    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledWith(
      'agent-1',
      'interaction-1',
      'CUSTOM_EVENT',
      'GET_TRANSCRIPTS',
      {action: 'START'},
      'en',
    ));
    expect(controller.getSnapshot()).toMatchObject({
      transcriptionStatus: 'requested',
      transcriptionMessage: expect.stringContaining('Waiting for the first utterance'),
    });

    task.emitTest('task:end');

    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledWith(
      'agent-1',
      'interaction-1',
      'CUSTOM_EVENT',
      'GET_TRANSCRIPTS',
      {action: 'STOP'},
      'en',
    ));
  });

  it('does not start streaming when the registered profile disables transcription', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const sendEvent = vi.fn(async () => ({}));
    const internal = controller as unknown as {
      cc: {apiAIAssistant: {sendEvent: typeof sendEvent}};
      profile: Profile;
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.cc = {apiAIAssistant: {sendEvent}};
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.task = task;
    internal.update({realtimeTranscriptionEnabled: false});

    await expect(controller.startTranscription()).rejects.toThrow('not enabled');

    expect(sendEvent).not.toHaveBeenCalled();
    expect(controller.getSnapshot().transcriptionStatus).toBe('unavailable');
  });
});

describe('WebexController AI response lifecycle', () => {
  it('distinguishes an accepted assistance request from a received suggestion', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const getRealTimeAssistance = vi.fn(async () => ({}));
    const internal = controller as unknown as {
      cc: {apiAIAssistant: {getRealTimeAssistance: typeof getRealTimeAssistance}};
      profile: Profile;
      task: ITask;
    };
    internal.cc = {apiAIAssistant: {getRealTimeAssistance}};
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.task = task;
    observeTask(controller, task);

    await controller.requestAssistance();

    expect(controller.getSnapshot()).toMatchObject({
      aiAssistanceLoading: false,
      aiAssistanceStatus: 'accepted',
      aiAssistanceMessage: expect.stringContaining('Waiting'),
    });

    task.emitTest('SUGGESTED_RESPONSE', {
      data: {adaptiveCardId: 'card-1', content: 'Suggested response content'},
    });

    expect(controller.getSnapshot()).toMatchObject({
      aiAssistanceStatus: 'received',
      aiSuggestions: [expect.objectContaining({adaptiveCardId: 'card-1'})],
    });
  });

  it('accepts summary requests and consumes the declared raw RTD summary event', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const sendEvent = vi.fn(async () => ({}));
    const internal = controller as unknown as {
      cc: {apiAIAssistant: {sendEvent: typeof sendEvent}};
      profile: Profile;
      task: ITask;
      handleRawAIEvent: (event: string) => void;
    };
    internal.cc = {apiAIAssistant: {sendEvent}};
    internal.profile = {agentId: 'agent-1'} as Profile;
    internal.task = task;

    await controller.requestSummary('mid-call');

    expect(controller.getSnapshot()).toMatchObject({
      aiSummaryLoading: false,
      aiSummaryStatus: 'accepted',
      aiSummaryMessage: expect.stringContaining('Waiting'),
    });

    internal.handleRawAIEvent(JSON.stringify({
      type: 'MID_CALL_SUMMARY',
      data: {
        data: {conversationId: 'interaction-1'},
        summary: 'Customer asked about the current plan.',
      },
    }));
    expect(controller.getSnapshot()).toMatchObject({
      aiSummaryStatus: 'received',
      midCallSummary: 'Customer asked about the current plan.',
    });

    internal.handleRawAIEvent(JSON.stringify({
      type: 'MID_CALL_SUMMARY',
      data: {
        data: {
          adaptiveCard: {
            id: 'card-2',
            type: 'AdaptiveCard',
            version: '1.6',
          },
          conversationId: 'interaction-1',
          sections: {
            additionalContext: 'Customer needs a billing correction.',
            keyActionsTaken: 'The agent reviewed the current invoice.',
            reasonForTransferOrConsult: 'A billing specialist should confirm the adjusted total.',
          },
        },
        notifDetails: {actionEvent: 'MID_CALL_SUMMARY'},
        notifType: 'MID_CALL_SUMMARY',
      },
    }));
    expect(controller.getSnapshot()).toMatchObject({
      aiSummaryStatus: 'received',
      midCallSummary: expect.stringMatching(
        /Additional context: Customer needs a billing correction[\s\S]*Key actions taken:[\s\S]*Reason for transfer or consult:/,
      ),
    });
  });
});

describe('WebexController idle reasons', () => {
  it('uses the idle reason selected by the agent', async () => {
    const controller = new WebexController();
    const setAgentState = vi.fn(async () => undefined);
    const internal = controller as unknown as {
      cc: {setAgentState: typeof setAgentState};
      profile: Profile;
    };
    internal.cc = {setAgentState};
    internal.profile = {
      agentId: 'agent-1',
      idleCodes: [
        {id: 'system', name: 'System reason', isSystem: true},
        {id: 'break', name: 'Break', isSystem: false},
      ],
    } as Profile;

    await controller.setIdle('break');

    expect(setAgentState).toHaveBeenCalledWith(
      expect.objectContaining({state: 'Idle', auxCodeId: 'break'}),
    );
    expect(controller.getSnapshot().selectedIdleCode).toBe('break');
    expect(controller.getSnapshot().agentState).toBe('Break');
  });

  it('does not allow system-managed idle reasons to be selected', async () => {
    const controller = new WebexController();
    const internal = controller as unknown as {
      cc: {setAgentState: ReturnType<typeof vi.fn>};
      profile: Profile;
    };
    internal.cc = {setAgentState: vi.fn()};
    internal.profile = {
      agentId: 'agent-1',
      idleCodes: [{id: 'system', name: 'System reason', isSystem: true}],
    } as Profile;

    await expect(controller.setIdle('system')).rejects.toThrow(
      'No idle auxiliary code is available',
    );
  });
});

describe('WebexController call controls', () => {
  it('answers a Webex App offer through the Contact Center task', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    observeTask(controller, task);
    internal.update({callStatus: 'ringing', acceptCapable: true});

    await controller.answer();

    expect(task.accept).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().callStatus).toBe('answering');

    task.emitTest('task:assigned');

    expect(controller.getSnapshot()).toMatchObject({
      callStatus: 'connected',
      holdCapable: true,
      endCapable: true,
      muteCapable: true,
      dtmfCapable: true,
    });
  });

  it('declines a Webex App offer through the Contact Center task', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({callStatus: 'ringing', declineCapable: true, activeTask: task});

    await controller.decline();

    expect(task.decline).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().callStatus).toBe('none');
    expect(controller.getSnapshot().activeTask).toBeUndefined();
  });

  it('mutes and sends DTMF through the Contact Center task', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({
      callStatus: 'connected',
      muteCapable: true,
      dtmfCapable: true,
      activeTask: task,
    });

    await controller.toggleMute();
    await controller.sendDigit('5');

    expect(task.toggleMute).toHaveBeenCalledWith({muted: true});
    expect(task.transmitDtmf).toHaveBeenCalledWith({dtmf: '5'});
    expect(controller.getSnapshot().muted).toBe(true);
  });

  it('enables DTMF when the Webex App call is correlated before the keypad control updates', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    (task.uiControls as any).main.keypad = {isVisible: false, isEnabled: false};
    (task as any).getWebexCallingCallId = () => 'correlated-call-id';
    const internal = controller as unknown as {task: ITask};
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('task:ui-controls-updated');

    expect(controller.getSnapshot().dtmfCapable).toBe(true);
  });

  it('holds and resumes through the Contact Center task', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({callStatus: 'connected', holdCapable: true, activeTask: task});

    await controller.toggleHold();
    await controller.toggleHold();

    expect(task.hold).toHaveBeenCalledOnce();
    expect(task.resume).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().callStatus).toBe('connected');
  });

  it('synchronizes mute changes emitted by the Webex App SDK path', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('task:wxapp-mute-state-updated', {muted: true});

    expect(controller.getSnapshot().muted).toBe(true);
  });

  it('exposes WebRTC remote audio from the task media event', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const track = {kind: 'audio'} as MediaStreamTrack;
    const internal = controller as unknown as {
      task: ITask;
    };
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('task:media', track);

    expect(controller.getSnapshot().remoteAudioTrack).toBe(track);
  });

  it('maps active-leg consult and conference capabilities from SDK UI controls', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {task: ITask};
    internal.task = task;
    observeTask(controller, task);
    (task.uiControls as any).activeLeg = 'consult';
    (task.uiControls as any).main.consult = {isVisible: true, isEnabled: true};
    (task.uiControls as any).main.transfer = {isVisible: true, isEnabled: true};
    (task.uiControls as any).consult = {
      hold: {isVisible: true, isEnabled: true},
      mute: {isVisible: true, isEnabled: true},
      keypad: {isVisible: true, isEnabled: true},
      switch: {isVisible: true, isEnabled: true},
      conference: {isVisible: true, isEnabled: true},
      consultTransfer: {isVisible: true, isEnabled: true},
      endConsult: {isVisible: true, isEnabled: true},
      transferConference: {isVisible: true, isEnabled: true},
    };

    task.emitTest('task:ui-controls-updated');

    expect(controller.getSnapshot()).toMatchObject({
      activeLeg: 'consult',
      consultCapable: true,
      transferCapable: true,
      switchCapable: true,
      conferenceCapable: true,
      consultTransferCapable: true,
      endConsultCapable: true,
      transferConferenceCapable: true,
    });
  });

  it('stores live transcript updates by message ID', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {task: ITask};
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('REAL_TIME_TRANSCRIPTION', {
      data: {messageId: 'message-1', role: 'CUSTOMER', content: 'Initial words', isFinal: false},
    });
    task.emitTest('REAL_TIME_TRANSCRIPTION', {
      data: {messageId: 'message-1', role: 'CUSTOMER', content: 'Final words', isFinal: true},
    });

    expect(controller.getSnapshot().transcripts).toEqual([
      expect.objectContaining({id: 'message-1', content: 'Final words', isFinal: true}),
    ]);
  });

  it('uses the Contact Center task for recording controls', async () => {
    const controller = new WebexController();
    const pauseRecording = vi.fn(async () => undefined);
    const resumeRecording = vi.fn(async () => undefined);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = {pauseRecording, resumeRecording} as unknown as ITask;
    internal.update({
      callStatus: 'connected',
      recordingPauseCapable: true,
      recordingPaused: false,
    });

    await controller.toggleRecording();
    await controller.toggleRecording();

    expect(pauseRecording).toHaveBeenCalledOnce();
    expect(resumeRecording).toHaveBeenCalledWith({autoResumed: false});
    expect(controller.getSnapshot().recordingPaused).toBe(false);
  });

  it('reflects recording start and the SDK recording control state', () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const mutableTask = task as unknown as {
      data: Record<string, any>;
      uiControls: Record<string, any>;
    };
    mutableTask.data.interaction = {
      callProcessingDetails: {
        recordingStarted: true,
        recordInProgress: true,
        pauseResumeEnabled: true,
      },
    };
    mutableTask.uiControls.main.recording = {isVisible: true, isEnabled: true};
    const internal = controller as unknown as {task: ITask};
    internal.task = task;
    observeTask(controller, task);

    task.emitTest('task:recordingStarted');

    expect(controller.getSnapshot()).toMatchObject({
      recordingActive: true,
      recordingPaused: false,
      recordingPauseCapable: true,
    });

    mutableTask.uiControls.main.recording = {isVisible: true, isEnabled: false};
    task.emitTest('task:ui-controls-updated');
    expect(controller.getSnapshot()).toMatchObject({
      recordingActive: true,
      recordingPauseCapable: false,
    });
  });

  it('merges an active consultation into a conference', async () => {
    const controller = new WebexController();
    const consultConference = vi.fn(async () => undefined);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = {consultConference} as unknown as ITask;
    internal.update({consultActive: true, conferenceActive: false});

    await controller.startConference();

    expect(consultConference).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().consultActive).toBe(false);
    expect(controller.getSnapshot().conferenceActive).toBe(true);
  });

  it('cancels a pending queue consultation with the destination queue ID', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({
      activeTask: task,
      destinations: [{id: 'queue-7', name: 'Support queue', type: 'queue'}],
    });

    await controller.consult('queue-7');
    await controller.endConsult();

    expect(task.consult).toHaveBeenCalledWith({
      to: 'queue-7',
      destinationType: 'queue',
      holdParticipants: true,
    });
    expect(task.endConsult).toHaveBeenCalledWith({
      isConsult: true,
      taskId: 'interaction-1',
      queueId: 'queue-7',
    });
    expect(controller.getSnapshot()).toMatchObject({
      consultActive: false,
      consultStatus: 'none',
      consultDestinationId: '',
      consultDestinationType: '',
      consultDestinationName: '',
    });
  });

  it('ends a connected consultation without the pending queue cancellation field', async () => {
    const controller = new WebexController();
    const task = fakeTask(false);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = task;
    internal.update({
      activeTask: task,
      consultActive: true,
      consultStatus: 'connected',
      consultDestinationId: 'queue-7',
      consultDestinationType: 'queue',
    });

    await controller.endConsult();

    expect(task.endConsult).toHaveBeenCalledWith({
      isConsult: true,
      taskId: 'interaction-1',
    });
  });

  it('exits an active conference through the Contact Center task', async () => {
    const controller = new WebexController();
    const exitConference = vi.fn(async () => undefined);
    const internal = controller as unknown as {
      task: ITask;
      update: (patch: Record<string, unknown>) => void;
    };
    internal.task = {exitConference} as unknown as ITask;
    internal.update({conferenceActive: true});

    await controller.exitConference();

    expect(exitConference).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().conferenceActive).toBe(false);
  });
});
