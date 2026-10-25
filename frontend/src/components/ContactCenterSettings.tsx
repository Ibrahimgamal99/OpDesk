import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Timer } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { Alert, Card, FormField, FormRow } from './ui';

/* Contact-center timing: the wrap-up auto-release and the daily shift reset.
 *
 * Two settings, two endpoints, one Save: only the setting that changed is sent, so a shift
 * reset that failed to load can never be saved back as "off". Both apply from the next call /
 * the next boundary on the backend, so nothing restarts.
 *
 * GET is open to any signed-in user; POST is admin-only, so a supervisor sees the values
 * read-only. */

type Message = { type: 'success' | 'error'; text: string } | null;

interface WrapUpConfig { max_secs?: number; min_secs?: number; max_secs_limit?: number; message?: string }
interface ShiftResetConfig { time?: string; message?: string }

export function ContactCenterSettings({ isAdmin, onWrapUpChange }: {
  isAdmin: boolean;
  /** Reports the stored wrap-up ceiling, for the home card's status line. */
  onWrapUpChange?: (maxSecs: number) => void;
}) {
  const { t } = useTranslation();
  // Bounds come from the server, so the input and the backend clamp never disagree.
  const [wrapUpMax, setWrapUpMax] = useState<number | null>(null);
  const [wrapUpSaved, setWrapUpSaved] = useState<number | null>(null);
  const [bounds, setBounds] = useState({ min: 0, max: 1800 });
  const [shiftReset, setShiftReset] = useState('');
  const [shiftResetSaved, setShiftResetSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [wrapUpMessage, setWrapUpMessage] = useState<Message>(null);
  const [shiftMessage, setShiftMessage] = useState<Message>(null);

  const load = useCallback(() => {
    api<WrapUpConfig>('/api/agents/wrapup-config')
      .then(d => {
        const v = d.max_secs ?? 120;
        setWrapUpMax(v);
        setWrapUpSaved(v);
        setBounds({ min: d.min_secs ?? 0, max: d.max_secs_limit ?? 1800 });
        onWrapUpChange?.(v);
      })
      .catch(e => setWrapUpMessage({ type: 'error', text: messageOf(e, t('settings.contactCenter.wrapUpLoadFailed', 'Could not read the wrap-up setting.')) }));
    api<ShiftResetConfig>('/api/agents/shift-reset')
      .then(d => { setShiftReset(d.time ?? ''); setShiftResetSaved(d.time ?? ''); })
      .catch(e => setShiftMessage({ type: 'error', text: messageOf(e, t('settings.contactCenter.shiftResetLoadFailed', 'Could not read the shift reset time.')) }));
  // onWrapUpChange is a parent callback; reading it fresh each call is fine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const wrapUpDirty = wrapUpMax !== null && wrapUpMax !== wrapUpSaved;
  const shiftDirty = shiftResetSaved !== null && shiftReset !== shiftResetSaved;

  const saveWrapUp = async () => {
    if (wrapUpMax === null) return;
    setWrapUpMessage(null);
    try {
      const d = await api<WrapUpConfig>('/api/agents/wrapup-config', { method: 'POST', body: { max_secs: wrapUpMax } });
      // Show what the server stored, not what was sent: it clamps.
      const v = d?.max_secs ?? wrapUpMax;
      setWrapUpMax(v);
      setWrapUpSaved(v);
      onWrapUpChange?.(v);
      setWrapUpMessage({
        type: 'success',
        text: v === 0
          ? t('settings.contactCenter.wrapUpOffSaved', 'Wrap-up auto-release turned off: agents stay in wrap-up until they finish it.')
          : t('settings.contactCenter.wrapUpSaved', { defaultValue: 'Wrap-up ceiling set to {{n}} s. Applies from the next completed call.', n: v }),
      });
    } catch (e) {
      setWrapUpMessage({ type: 'error', text: messageOf(e, t('settings.contactCenter.wrapUpSaveFailed', 'Could not save the wrap-up setting.')) });
    }
  };

  const saveShiftReset = async () => {
    setShiftMessage(null);
    try {
      const d = await api<ShiftResetConfig>('/api/agents/shift-reset', { method: 'POST', body: { time: shiftReset } });
      // The server normalises the time and blanks an "off".
      const v = d?.time ?? shiftReset;
      setShiftReset(v);
      setShiftResetSaved(v);
      setShiftMessage({
        type: 'success',
        text: v
          ? t('settings.contactCenter.shiftResetSaved', { defaultValue: 'Agents are logged out of their queues at {{time}} each day.', time: v })
          : t('settings.contactCenter.shiftResetOffSaved', 'Daily shift reset turned off: agents stay logged in until they log out.'),
      });
    } catch (e) {
      setShiftMessage({ type: 'error', text: messageOf(e, t('settings.contactCenter.shiftResetSaveFailed', 'Could not save the shift reset time.')) });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await Promise.all([wrapUpDirty ? saveWrapUp() : null, shiftDirty ? saveShiftReset() : null]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      icon={Timer}
      title={t('settings.contactCenter.title', 'Wrap-up and shift reset')}
      description={t('settings.contactCenter.description', 'After-call work and the daily logout that closes each shift.')}
      footer={isAdmin ? (
        <button type="button" className="btn btn-primary" disabled={saving || (!wrapUpDirty && !shiftDirty)} onClick={save}>
          {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
          {saving ? t('settings.contactCenter.saving', 'Saving…') : t('settings.contactCenter.save', 'Save changes')}
        </button>
      ) : undefined}
      bodyClassName="u-col u-gap-3"
    >
      <FormRow>
        <FormField
          label={t('settings.contactCenter.wrapUpLabel', 'Wrap-up ceiling (seconds)')}
          htmlFor="wrapup-max"
          hint={t('settings.contactCenter.wrapUpHelp', 'How long an agent stays paused after a queue call before returning to Ready. They can finish sooner from their status menu, so this is a ceiling, not a fixed delay. 0 turns the auto-release off. Applies from the next completed call.')}
        >
          <input
            id="wrapup-max"
            aria-label={t('settings.contactCenter.wrapUpLabel', 'Wrap-up ceiling (seconds)')}
            type="number"
            className="form-input"
            value={wrapUpMax ?? ''}
            min={bounds.min}
            max={bounds.max}
            disabled={wrapUpMax === null || !isAdmin}
            onChange={e => setWrapUpMax(Math.max(bounds.min, Math.min(bounds.max, parseInt(e.target.value, 10) || 0)))}
          />
        </FormField>
        <FormField
          label={t('settings.contactCenter.shiftResetLabel', 'Daily shift reset')}
          htmlFor="shift-reset"
          hint={t('settings.contactCenter.shiftResetHelp', 'At this time each day every signed-in agent is logged out of their queues, so a shift left open does not run into the next one and Agent Adherence reports one shift per day. An agent on a call is logged out when the call ends; an agent on Do Not Disturb is left alone. Clear the field to turn the reset off.')}
        >
          <input
            id="shift-reset"
            aria-label={t('settings.contactCenter.shiftResetLabel', 'Daily shift reset')}
            type="time"
            className="form-input"
            dir="ltr"
            value={shiftReset}
            disabled={shiftResetSaved === null || !isAdmin}
            onChange={e => setShiftReset(e.target.value)}
          />
        </FormField>
      </FormRow>
      <Alert tone={wrapUpMessage?.type === 'success' ? 'success' : 'error'}>{wrapUpMessage?.text}</Alert>
      <Alert tone={shiftMessage?.type === 'success' ? 'success' : 'error'}>{shiftMessage?.text}</Alert>
    </Card>
  );
}
