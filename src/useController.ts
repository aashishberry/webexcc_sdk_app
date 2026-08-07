import {useEffect, useMemo, useState} from 'react';
import {WebexPocController} from './WebexPocController';

export function useController() {
  const controller = useMemo(() => new WebexPocController(), []);
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  return {controller, snapshot};
}
