import { amiActionAllowed, commandAllowed, shadowMode } from '../src/core/shadow';

describe('shadow mode guards', () => {
  const saved = process.env.OPDESK_SHADOW;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPDESK_SHADOW;
    else process.env.OPDESK_SHADOW = saved;
  });

  test('off: everything is allowed', () => {
    delete process.env.OPDESK_SHADOW;
    expect(shadowMode()).toBe(false);
    expect(amiActionAllowed('QueuePause', { Queue: '600' })).toBe(true);
    expect(commandAllowed(['sudo', 'cp', '/tmp/x', '/etc/asterisk/x.conf'])).toBe(true);
  });

  test('on: only read-only AMI actions reach Asterisk', () => {
    process.env.OPDESK_SHADOW = '1';
    for (const a of ['Login', 'Events', 'CoreShowChannels', 'QueueStatus', 'ExtensionStateList', 'DBGet', 'PJSIPShowContacts']) {
      expect(amiActionAllowed(a, {})).toBe(true);
    }
    for (const a of ['QueuePause', 'QueueAdd', 'QueueRemove', 'Originate', 'Hangup', 'Redirect', 'DBPut', 'DBDel', 'Setvar']) {
      expect(amiActionAllowed(a, {})).toBe(false);
    }
    expect(amiActionAllowed('Command', { Command: 'database show DND' })).toBe(true);
    expect(amiActionAllowed('Command', { Command: 'core reload' })).toBe(false);
    expect(amiActionAllowed('Command', { Command: 'database put DND 100 YES' })).toBe(false);
  });

  test('on: only read-only asterisk CLI child processes run', () => {
    process.env.OPDESK_SHADOW = 'true';
    expect(commandAllowed(['asterisk', '-rx', 'pjsip show contacts'])).toBe(true);
    expect(commandAllowed(['sudo', '-n', '/usr/sbin/asterisk', '-rx', 'core show channels'])).toBe(true);
    expect(commandAllowed(['asterisk', '-rx', 'dialplan reload'])).toBe(false);
    expect(commandAllowed(['sudo', 'cp', '/tmp/x', '/etc/asterisk/extensions_opdesk.conf'])).toBe(false);
    expect(commandAllowed(['fwconsole', 'reload'])).toBe(false);
    expect(commandAllowed(['amportal', 'a', 'r'])).toBe(false);
  });
});
