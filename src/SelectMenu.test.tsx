// @vitest-environment jsdom

import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SelectMenu} from './SelectMenu';

const options = [
  {value: 'available', label: 'Available'},
  {value: 'break', label: 'Break', group: 'Idle reasons'},
  {value: 'system', label: 'System reason', disabled: true, group: 'Idle reasons'},
];

afterEach(cleanup);

describe('SelectMenu', () => {
  it('visually distinguishes the selected option', () => {
    render(
      <SelectMenu
        ariaLabel="Agent state"
        value="break"
        options={options}
        onChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', {name: 'Agent state'}));

    expect(screen.getByRole('option', {name: 'Break'}).classList.contains('is-selected')).toBe(true);
    expect(screen.getByRole('option', {name: 'Available'}).classList.contains('is-selected')).toBe(false);
    expect(screen.getByText('Idle reasons')).toBeTruthy();
  });

  it('supports keyboard navigation and selection', () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        ariaLabel="Agent state"
        value="available"
        options={options}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole('combobox', {name: 'Agent state'});

    fireEvent.keyDown(trigger, {key: 'ArrowDown'});
    fireEvent.keyDown(trigger, {key: 'ArrowDown'});
    fireEvent.keyDown(trigger, {key: 'Enter'});

    expect(onChange).toHaveBeenCalledWith('break');
  });
});
