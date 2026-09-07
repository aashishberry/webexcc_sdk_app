import {useEffect, useMemo, useState} from 'react';
import {WebexController} from './WebexController';

export function useController() {
  const controller = useMemo(() => new WebexController(), []);
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  return {controller, snapshot};
}
