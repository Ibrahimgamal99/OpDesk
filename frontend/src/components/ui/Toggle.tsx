import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  icon?: React.ReactNode;
  iconOff?: React.ReactNode;
  disabled?: boolean;
  id?: string;
}

export function Toggle({ checked, onChange, label, description, icon, iconOff, disabled, id }: ToggleProps) {
  const handleClick = () => {
    if (!disabled) onChange(!checked);
  };
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      id={id}
      className={`ui-toggle-row${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={handleClick}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKey}
    >
      <div className={`ui-toggle-switch${checked ? ' active' : ''}`}>
        <div className="ui-toggle-knob">
          {checked ? (icon ?? null) : (iconOff ?? null)}
        </div>
      </div>
      {(label || description) && (
        <div className="ui-toggle-info">
          {label && <span className="ui-toggle-label">{label}</span>}
          {description && <span className="ui-toggle-desc">{description}</span>}
        </div>
      )}
    </div>
  );
}
