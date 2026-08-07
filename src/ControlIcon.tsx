interface ControlIconProps {
  name: 'bell' | 'theme' | 'mute' | 'hold' | 'keypad' | 'record' | 'consult' | 'transfer' | 'phone' | 'close';
}

export function ControlIcon({name}: ControlIconProps) {
  const paths: Record<ControlIconProps['name'], React.ReactNode> = {
    bell: <><path d="M6 17h12l-1.5-2.2V10a4.5 4.5 0 0 0-9 0v4.8L6 17Z"/><path d="M10 20h4"/></>,
    theme: <><path d="M12 3a9 9 0 1 0 9 9c-5 2-9-2-9-9Z"/></>,
    mute: <><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 11V9a3 3 0 0 0-5.8-1"/><path d="M5 11v1a7 7 0 0 0 11.7 5.2M19 11v1a7 7 0 0 1-.7 3M12 19v3M8 22h8M4 4l16 16"/></>,
    hold: <><path d="M8 5v14M16 5v14"/></>,
    keypad: <><circle cx="7" cy="7" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="17" cy="7" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="17" cy="12" r="1"/><circle cx="7" cy="17" r="1"/><circle cx="12" cy="17" r="1"/><circle cx="17" cy="17" r="1"/></>,
    record: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/></>,
    consult: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 8h5M18.5 5.5v5"/></>,
    transfer: <><path d="M5 7h12M14 4l3 3-3 3M19 17H7M10 14l-3 3 3 3"/></>,
    phone: <><path d="M7 4 4.5 6.5c1.2 6.5 6.5 11.8 13 13L20 17l-4-3-2 2c-2.4-1-4.9-3.5-6-6l2-2-3-4Z"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  };
  return <svg className="control-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
