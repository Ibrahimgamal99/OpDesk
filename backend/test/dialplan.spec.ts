/**
 * services/dialplan: every generated text, compared with what the Python dialplan.py wrote
 * (test/fixtures/dialplan/*.conf were produced by the Python functions with subprocess
 * stubbed), so a box switched over from the Python server keeps byte-identical QoS, mobile
 * wake and TLS config, and its existing blocks are recognised and replaced.
 *
 * Nothing here writes /etc/asterisk or runs a command: only the pure render*() functions
 * and text transforms are called (test/setup/no-host-commands.ts would fail the spec if
 * anything shelled out).
 */

jest.mock('../src/db/db-manager', () => ({ getSetting: jest.fn(async (_k: string, d: unknown) => d) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  chainHookText,
  hookExit,
  MOBILE_WAKE_OFF_CONTENT,
  OPDESK_REC_HOOK_LINE,
  OPDESK_REC_HOOK_MARK,
  parseRecordingPolicy,
  pbxApplyCommand,
  pbxKind,
  QOS_OFF_CONTENT,
  renderMobileWakeConf,
  renderQosConf,
  renderRecordingConf,
  renderRecordingOffConf,
  renderTlsBlock,
  renderTlsFile,
  stripTlsBlock,
  TLS_MARKER_END,
  TLS_MARKER_START,
  withInclude,
} from '../src/services/dialplan';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'dialplan', name), 'utf8');

describe('byte-identical to the Python output', () => {
  it('QoS on and off', () => {
    expect(renderQosConf()).toBe(fixture('qos.conf'));
    expect(QOS_OFF_CONTENT).toBe(fixture('qos_off.conf'));
  });

  it('mobile wake, with and without a settle wait, and off', () => {
    expect(renderMobileWakeConf(8765, 10, 3)).toBe(fixture('mobile_wake_10_3.conf'));
    expect(renderMobileWakeConf(8765, 12, 0)).toBe(fixture('mobile_wake_12_0.conf'));
    expect(MOBILE_WAKE_OFF_CONTENT).toBe(fixture('mobile_wake_off.conf'));
  });

  it('mobile wake clamps hold and settle to their ranges', () => {
    expect(renderMobileWakeConf(8765, 99, 99)).toContain('Set(WAITLEFT=30)');
    expect(renderMobileWakeConf(8765, 1, 3)).toContain('Set(WAITLEFT=8)');
    expect(renderMobileWakeConf(8765, 10, 99)).toContain('Wait(10)');
  });

  it('recording off (FreePBX) and the FreePBX TLS block', () => {
    expect(renderRecordingOffConf('FreePBX')).toBe(fixture('record_off.conf'));
    expect(renderTlsBlock('freepbx')).toBe(fixture('tls_freepbx.conf'));
  });
});

describe('recording dialplan', () => {
  const python = fixture('record_python.conf');
  const conf = renderRecordingConf({ format: 'wav', vad: true, pbx: 'FreePBX' });

  it('keeps the markers, contexts and file naming the Python wrote', () => {
    expect(conf.startsWith('; OpDesk call recording dialplan — auto-generated. Do not edit manually.\n')).toBe(true);
    for (const line of [
      '[macro-dialout-one-predial-hook]',
      '[macro-dialout-trunk-predial-hook]',
      '[opdesk-record]',
      'exten => s,1,GosubIf($["${OPDESK_REC}"=""]?opdesk-record,s,1)',
      ' same => n,Set(__OPDESK_REC=1)',
      ' same => n,Set(OPDESK_BASE=${OPDESK_TS}-${CALLERID(num)}-${OPDESK_DST}-${UNIQUEID})',
      ' same => n,Set(OPDESK_MIX=/var/spool/asterisk/monitor/${OPDESK_DAY}/${OPDESK_BASE}.wav)',
      ' same => n,Set(OPDESK_SP1=/var/spool/asterisk/single/${OPDESK_DAY}/${OPDESK_BASE}-sp1.wav)',
      ' same => n,Set(CDR(recordingfile)=${OPDESK_BASE}.wav)',
      ' same => n,UserEvent(OpDeskRecording,Recbase: ${OPDESK_SINGLE_BASE})',
    ]) {
      expect(python).toContain(line);
      expect(conf).toContain(line);
    }
  });

  it('records only while bridged (MixMonitor b flag)', () => {
    expect(python).toContain('MixMonitor(${OPDESK_MIX},r(${OPDESK_SP1})t(${OPDESK_SP2}))');
    expect(conf).toContain(' same => n,MixMonitor(${OPDESK_MIX},br(${OPDESK_SP1})t(${OPDESK_SP2}))');
  });

  it('applies the opt-out policy from the opdesk AstDB family', () => {
    expect(conf).toContain(
      ' same => n,Set(OPDESK_DIR=${IF($["${FROM_DID}"!=""]?inbound:${IF($["${DIAL_TRUNK}"!=""]?outbound:internal)})})',
    );
    expect(conf).toContain(' same => n,GotoIf($["${DB(opdesk/rec/dir/${OPDESK_DIR})}"="0"]?skip)');
    expect(conf).toContain(' same => n,GotoIf($["${DB(opdesk/rec/ext/${OPDESK_EXT})}"="0"]?skip)');
    expect(conf).toContain(' same => n,GotoIf($["${DB(opdesk/rec/ext/${EXTTOCALL})}"="0"]?skip)');
    expect(conf).toMatch(/ same => n\(skip\),NoOp\(OpDesk recording skipped by policy/);
    // the skip label is reached only past the normal Return()
    expect(conf.indexOf(' same => n,Return()\n same => n(skip)')).toBeGreaterThan(0);
  });

  it('leaves the VAD event out when asked', () => {
    const noVad = renderRecordingConf({ format: 'gsm', vad: false, pbx: 'FreePBX' });
    expect(noVad).not.toContain('UserEvent(OpDeskRecording');
    expect(noVad).toContain('${OPDESK_BASE}.gsm');
  });

  it('FreePBX hooks Return(); IssabelPBX (Macro-invoked hooks) MacroExit()', () => {
    expect(conf).toContain('?opdesk-record,s,1)\n same => n,Return()\n');
    const issabel = renderRecordingConf({ format: 'wav', vad: true, pbx: 'Issabel' });
    expect(issabel).toContain('?opdesk-record,s,1)\n same => n,MacroExit()\n');
    // [opdesk-record] itself is Gosub'd on both, so it still Returns.
    expect(issabel).toContain(' same => n,Return()\n same => n(skip)');
    expect(renderRecordingOffConf('Issabel')).toBe(
      '; OpDesk call recording disabled\n[macro-dialout-one-predial-hook]\nexten => s,1,MacroExit()\n\n' +
        '[macro-dialout-trunk-predial-hook]\nexten => s,1,MacroExit()\n',
    );
  });
});

describe('PBX flavour', () => {
  it('reads Issabel case-insensitively, FreePBX otherwise', () => {
    expect(pbxKind('Issabel')).toBe('issabel');
    expect(pbxKind('issabel ')).toBe('issabel');
    expect(pbxKind('FreePBX')).toBe('freepbx');
    expect(hookExit('Issabel')).toBe('MacroExit()');
    expect(pbxApplyCommand('Issabel')).toBe('amportal a r');
    expect(pbxApplyCommand('FreePBX')).toBe('fwconsole reload');
  });
});

describe('extensions_custom.conf edits', () => {
  it('appends an #include once, recognising relative and absolute forms', () => {
    expect(withInclude('', 'extensions_opdesk.conf')).toBe('#include extensions_opdesk.conf\n');
    expect(withInclude('[x]\nexten => s,1,NoOp()', 'extensions_opdesk.conf')).toBe(
      '[x]\nexten => s,1,NoOp()\n#include extensions_opdesk.conf\n',
    );
    expect(withInclude('#include extensions_opdesk.conf\n', 'extensions_opdesk.conf')).toBeNull();
    expect(
      withInclude('#include /etc/asterisk/extensions_opdesk.conf\n', 'extensions_opdesk.conf', '/etc/asterisk/extensions_opdesk.conf'),
    ).toBeNull();
  });

  const custom = [
    '[from-internal-custom]',
    '',
    '[macro-dialout-trunk-predial-hook]',
    'exten => s,1,NoOp(sticky routing)',
    ' same => n,Set(LAST=${DB(sticky/${CALLERID(num)})})',
    ' same => n,Return()',
    '',
    '#include extensions_opdesk_record.conf',
  ].join('\n') + '\n';

  it('chains the recorder into a pre-existing trunk hook, idempotently, and removes it', () => {
    const chained = chainHookText(custom, OPDESK_REC_HOOK_MARK, OPDESK_REC_HOOK_LINE, true) as string;
    expect(chained.split('\n')[4]).toBe(`${OPDESK_REC_HOOK_LINE} ${OPDESK_REC_HOOK_MARK}`);
    expect(chained.split('\n')[3]).toBe('exten => s,1,NoOp(sticky routing)');
    expect(chainHookText(chained, OPDESK_REC_HOOK_MARK, OPDESK_REC_HOOK_LINE, true)).toBeNull();
    expect(chainHookText(chained, OPDESK_REC_HOOK_MARK, OPDESK_REC_HOOK_LINE, false)).toBe(custom);
  });

  it('does nothing when no trunk hook block exists', () => {
    expect(chainHookText('[from-internal-custom]\n', OPDESK_REC_HOOK_MARK, OPDESK_REC_HOOK_LINE, true)).toBeNull();
  });
});

describe('SIP TLS block', () => {
  it('replaces an existing OpDesk block instead of stacking a second one', () => {
    const other = '[transport-wss]\ntype=transport\nprotocol=wss\n';
    const once = renderTlsFile(other, 'issabel');
    const twice = renderTlsFile(once, 'issabel');
    expect(twice).toBe(once);
    expect(twice.split(TLS_MARKER_START).length).toBe(2);
    expect(twice).toContain('[opdesk-sip-tls]');
    expect(twice.startsWith(other)).toBe(true);
  });

  it('a Python-written block is recognised and stripped, the rest kept', () => {
    const python = '[keep]\nx=1\n' + fixture('tls_freepbx.conf') + '[after]\ny=2\n';
    expect(stripTlsBlock(python)).toBe('[keep]\nx=1\n[after]\ny=2\n');
    expect(renderTlsFile('', 'freepbx')).toBe(fixture('tls_freepbx.conf'));
    expect(fixture('tls_freepbx.conf').trim().endsWith(TLS_MARKER_END)).toBe(true);
  });
});

describe('recording policy parsing', () => {
  it('reads `database show opdesk/rec`', () => {
    const out = [
      '/opdesk/rec/dir/inbound                           : 0',
      '/opdesk/rec/dir/outbound                          : 1',
      '/opdesk/rec/ext/101                               : 0',
      '/opdesk/rec/ext/100                               : 0',
      '/opdesk/rec/ext/102                               : 1',
      '/opdesk/wakeready/100                             : 1',
      '4 results found.',
    ].join('\n');
    expect(parseRecordingPolicy(out)).toEqual({
      directions: { inbound: false, outbound: true, internal: true },
      extensions_opted_out: ['100', '101'],
    });
    expect(parseRecordingPolicy('')).toEqual({
      directions: { inbound: true, outbound: true, internal: true },
      extensions_opted_out: [],
    });
  });
});
