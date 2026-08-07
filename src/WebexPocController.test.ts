import {describe, expect, it, vi} from 'vitest';
import type {ITask, Profile} from '@webex/contact-center';
import {WebexPocController} from './WebexPocController';

vi.mock('@webex/contact-center', () => ({default: {}}));

type TaskListener = (task?: ITask) => void;

function fakeTask(wrapUpRequired: boolean): ITask & {emitTest: (event: string) => void} {
  const listeners = new Map<string, TaskListener[]>();
  const task = {
    data: {interactionId: 'interaction-1', wrapUpRequired},
    on(event: string, listener: TaskListener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return task;
    },
    emitTest(event: string) {
      for (const listener of listeners.get(event) ?? []) listener(task as unknown as ITask);
    },
  };
  return task as unknown as ITask & {emitTest: (event: string) => void};
}

function observeTask(controller: WebexPocController, task: ITask): void {
  const internal = controller as unknown as {attachTaskListeners: (candidate: ITask) => void};
  internal.attachTaskListeners(task);
}

function controllerInternals(controller: WebexPocController) {
  return controller as unknown as {
    api: {action: (...args: unknown[]) => Promise<void>; listCalls: () => Promise<unknown[]>};
    missingCallPolls: number;
    syncCall: () => Promise<void>;
    update: (patch: Record<string, unknown>) => void;
  };
}

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

  it('does not let a late hangup response overwrite Contact Center wrap-up', async () => {
    const controller = new WebexPocController();
    const task = fakeTask(true);
    const internal = controllerInternals(controller);
    observeTask(controller, task);
    internal.update({callId: 'call-1', callStatus: 'connected', activeTask: task});
    internal.api = {
      listCalls: async () => [],
      action: vi.fn(async () => task.emitTest('task:end')),
    };

    await controller.endCall();

    expect(controller.getSnapshot().callStatus).toBe('wrap-up');
  });

  it('does not let Calling polling overwrite Contact Center wrap-up', async () => {
    const controller = new WebexPocController();
    const internal = controllerInternals(controller);
    internal.update({callId: 'call-1', callStatus: 'wrap-up'});
    internal.missingCallPolls = 1;
    internal.api = {listCalls: async () => [], action: async () => undefined};

    await internal.syncCall();

    expect(controller.getSnapshot().callStatus).toBe('wrap-up');
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
  it('declines by ending the alerting Calling leg', async () => {
    const controller = new WebexPocController();
    const internal = controllerInternals(controller);
    const action = vi.fn(async () => undefined);
    internal.api = {action, listCalls: async () => []};
    internal.update({callId: 'call-1', callStatus: 'ringing'});

    await controller.decline();

    expect(action).toHaveBeenCalledWith('hangup', {callId: 'call-1'});
    expect(controller.getSnapshot().callStatus).toBe('none');
    expect(controller.getSnapshot().activeTask).toBeUndefined();
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
});
