import {describe, expect, it, vi} from 'vitest';
import type {ITask, Profile} from '@webex/contact-center';
import {WebexPocController} from './WebexPocController';

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

function observeTask(controller: WebexPocController, task: ITask): void {
  const internal = controller as unknown as {attachTaskListeners: (candidate: ITask) => void};
  internal.attachTaskListeners(task);
}

describe('WebexPocController performance', () => {
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

describe('WebexPocController station login', () => {
  it.each([
    ['EXTENSION', '4093'],
    ['AGENT_DN', '+14085550100'],
  ] as const)('passes %s and its dial number to the SDK', async (loginOption, dialNumber) => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

describe('WebexPocController task completion', () => {
  it('enables wrap-up when task:end reports wrapUpRequired', () => {
    const controller = new WebexPocController();
    const task = fakeTask(true);

    observeTask(controller, task);
    task.emitTest('task:end');

    expect(controller.getSnapshot().callStatus).toBe('wrap-up');
    expect(controller.getSnapshot().activeTask).toBe(task);
  });

  it('clears a completed task when task:end does not require wrap-up', () => {
    const controller = new WebexPocController();
    const task = fakeTask(false);

    observeTask(controller, task);
    task.emitTest('task:end');

    expect(controller.getSnapshot().callStatus).toBe('none');
    expect(controller.getSnapshot().activeTask).toBeUndefined();
  });

  it('uses the Contact Center task end event to enter wrap-up', async () => {
    const controller = new WebexPocController();
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

describe('WebexPocController transcription', () => {
  it('explicitly starts transcript streaming when an enabled task is assigned', async () => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

describe('WebexPocController AI response lifecycle', () => {
  it('distinguishes an accepted assistance request from a received suggestion', async () => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
  });
});

describe('WebexPocController idle reasons', () => {
  it('uses the idle reason selected by the agent', async () => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

describe('WebexPocController call controls', () => {
  it('answers a Webex App offer through the Contact Center task', async () => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

  it('holds and resumes through the Contact Center task', async () => {
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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
    const controller = new WebexPocController();
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

  it('merges an active consultation into a conference', async () => {
    const controller = new WebexPocController();
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

  it('exits an active conference through the Contact Center task', async () => {
    const controller = new WebexPocController();
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
