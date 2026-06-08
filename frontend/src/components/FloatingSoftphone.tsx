import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Headphones, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { Softphone } from './Softphone';

interface FloatingSoftphoneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 3CX-style floating dialer. A fixed action button (FAB) that toggles a popover
 * containing the existing <Softphone /> dialpad — callable from any screen.
 *
 * Softphone stays MOUNTED at all times (only the popover is hidden/shown). It holds
 * the remote-audio <audio> element whose stream is attached by an effect keyed on
 * remoteStream (useWebPhone.ts); unmounting it mid-call would silently drop call
 * audio, so we animate visibility instead of conditionally rendering it.
 */
export function FloatingSoftphone({ open, onOpenChange }: FloatingSoftphoneProps) {
  const { t } = useTranslation();
  const {
    isConnected,
    incomingCall,
    hasActiveCall,
    isCallAnswered,
    isOutgoingRinging,
  } = useWebPhoneContext();

  const wrapRef = useRef<HTMLDivElement>(null);
  const inCall = hasActiveCall || isCallAnswered || isOutgoingRinging;

  // Auto-open the popover when a call comes in (replaces the old tab redirect).
  useEffect(() => {
    if (incomingCall) onOpenChange(true);
  }, [incomingCall, onOpenChange]);

  // Close on Escape — but never while a call is ringing in (don't hide the answer screen).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !incomingCall) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, incomingCall, onOpenChange]);

  // Close on outside click (mirrors the dropdown pattern used in App.tsx).
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (incomingCall) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', onOutside, true);
    return () => document.removeEventListener('mousedown', onOutside, true);
  }, [open, incomingCall, onOpenChange]);

  const fabClass = [
    'softphone-fab',
    isConnected ? 'softphone-fab--registered' : 'softphone-fab--offline',
    incomingCall ? 'softphone-fab--ringing' : '',
    !incomingCall && inCall ? 'softphone-fab--in-call' : '',
    open ? 'is-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={wrapRef}>
      {open && (
        <div
          className="softphone-popover-backdrop"
          onClick={() => {
            if (!incomingCall) onOpenChange(false);
          }}
        />
      )}

      {/* Popover stays mounted; we animate opacity/transform so the audio element survives. */}
      <motion.div
        className="softphone-popover"
        role="dialog"
        aria-label={t('softphone.title')}
        aria-hidden={!open}
        initial={false}
        animate={
          open
            ? { opacity: 1, y: 0, scale: 1, pointerEvents: 'auto' }
            : { opacity: 0, y: 16, scale: 0.98, pointerEvents: 'none' }
        }
        transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
      >
        <Softphone />
      </motion.div>

      <button
        type="button"
        className={fabClass}
        onClick={() => onOpenChange(!open)}
        aria-label={open ? t('softphone.closeDialer') : t('softphone.openDialer')}
        aria-pressed={open}
        title={isConnected ? t('header.softphoneRegistered') : t('header.softphoneNotRegistered')}
      >
        {open && !incomingCall && !inCall ? <X size={24} /> : <Headphones size={24} />}
        <span className="softphone-fab-dot" aria-hidden />
        {incomingCall && <span className="softphone-fab-badge">1</span>}
      </button>
    </div>
  );
}
