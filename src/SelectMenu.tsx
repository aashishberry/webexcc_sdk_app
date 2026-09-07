import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent} from 'react';
import {menuViewportShift} from './selectMenuPosition';

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

interface SelectMenuProps {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

export function SelectMenu({
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  ariaLabel,
  disabled = false,
  className = '',
}: SelectMenuProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabledIndex = options.findIndex((option) => !option.disabled);
  const [activeIndex, setActiveIndex] = useState(
    selectedIndex >= 0 ? selectedIndex : firstEnabledIndex,
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !popover.current) return;
    const keepInsideViewport = () => {
      if (!popover.current) return;
      popover.current.style.translate = '0 0';
      const shift = menuViewportShift(popover.current.getBoundingClientRect(), window.innerWidth);
      popover.current.style.translate = shift ? `${shift}px 0` : '';
    };
    keepInsideViewport();
    window.addEventListener('resize', keepInsideViewport);
    return () => window.removeEventListener('resize', keepInsideViewport);
  }, [open, options.length]);

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const move = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex;
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  return (
    <div ref={root} className={`select-menu ${open ? 'is-open' : ''} ${className}`}>
      <button
        type="button"
        className="select-menu-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? '' : 'select-placeholder'}>
          {selected?.label || placeholder}
        </span>
        <span className="select-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div ref={popover} id={`${id}-listbox`} className="select-menu-popover" role="listbox">
          {options.map((option, index) => {
            const showGroup = Boolean(
              option.group && option.group !== options[index - 1]?.group,
            );
            const isSelected = index === selectedIndex;
            const isActive = index === activeIndex;
            return (
              <div key={option.value}>
                {showGroup && <div className="select-group-label">{option.group}</div>}
                <button
                  id={`${id}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  tabIndex={-1}
                  className={`select-menu-option ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`}
                  onPointerEnter={() => !option.disabled && setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  {isSelected && <span className="option-check" aria-hidden="true">✓</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
