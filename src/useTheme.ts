import {useEffect, useState} from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem('webex-poc-theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    window.localStorage.setItem('webex-poc-theme', mode);
  }, [mode]);

  const cycle = () => setMode((current) =>
    current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
  );

  return {mode, cycle};
}
