/**
 * The ten-value call status: the vocabulary and its projection of retired spellings
 * (services/call-outcomes), the mapping from Asterisk signals (call-log.mapCallOutcome),
 * the CEL-based verdict for Call History (outcomeFromCel) and "who ended the call"
 * (callEndedBy). The CEL rows below are this PBX's real ones (asteriskcdrdb.cel, read-only).
 */

jest.mock('../src/db/db-manager', () => ({}));

import { CALL_OUTCOMES, callStatus, NOTIFY_OUTCOMES, RETIRED_SPELLINGS } from '../src/services/call-outcomes';
import { callEndedBy, CelFacts, channelParty, mapCallOutcome, outcomeFromCel } from '../src/services/call-log';

describe('vocabulary', () => {
  it('has exactly the ten statuses', () => {
    expect(CALL_OUTCOMES).toEqual([
      'ANSWERED', 'UNANSWERED', 'BUSY', 'MISSED', 'VOICEMAIL',
      'UNREACHABLE', 'FAILURE', 'NETWORK_ERROR', 'ABANDONED', 'DROPPED',
    ]);
  });

  it("projects OpDesk's old words and the bell's lowercase reasons", () => {
    const cases: Array<[string, string]> = [
      ['NO_ANSWER', 'UNANSWERED'], ['CANCELED', 'MISSED'], ['OUT_OF_REACH', 'UNREACHABLE'],
      ['busy', 'BUSY'], ['noanswer', 'UNANSWERED'], ['switched_off', 'UNREACHABLE'],
      ['failed', 'FAILURE'], ['invalid_number', 'FAILURE'], ['completed', 'ANSWERED'],
      ['answered', 'ANSWERED'], [' dropped ', 'DROPPED'],
    ];
    for (const [old, now] of cases) expect(callStatus(old)).toBe(now);
    for (const v of Object.values(RETIRED_SPELLINGS)) expect(CALL_OUTCOMES).toContain(v);
  });

  it('is null for anything that is not a call status', () => {
    expect(callStatus('callback_due')).toBeNull();
    expect(callStatus('')).toBeNull();
    expect(callStatus(null)).toBeNull();
    expect(callStatus(undefined)).toBeNull();
  });

  it('the bell notifies on refusals, ring-outs and failures, MISSED included', () => {
    expect([...NOTIFY_OUTCOMES].sort()).toEqual(['BUSY', 'FAILURE', 'MISSED', 'NETWORK_ERROR', 'UNANSWERED', 'UNREACHABLE']);
  });
});

describe('mapCallOutcome', () => {
  // [signals, expected] -- the matrix from the area-1 analysis (scratchpad a1/matrix.py).
  const cases: Array<[Parameters<typeof mapCallOutcome>[0], string]> = [
    [{ cause: '0' }, 'FAILURE'], // no cause reported: unknown, NOT busy (OpDesk said BUSY)
    [{ cause: 0, disposition: 'NO ANSWER' }, 'UNANSWERED'],
    [{ cause: '16' }, 'MISSED'], // caller gave up while it rang
    [{ cause: '16', outbound: true }, 'UNANSWERED'], // our agent gave up on an outbound call
    [{ dialStatus: 'CANCEL' }, 'MISSED'],
    [{ dialStatus: 'CANCEL', outbound: true }, 'UNANSWERED'],
    [{ dialStatus: 'NOANSWER' }, 'UNANSWERED'],
    [{ dialStatus: 'NOANSWER', cause: '17' }, 'BUSY'],
    [{ dialStatus: 'NOANSWER', cause: '21' }, 'BUSY'],
    [{ dialStatus: 'CHANUNAVAIL' }, 'UNREACHABLE'],
    [{ dialStatus: 'CONGESTION' }, 'NETWORK_ERROR'],
    [{ dialStatus: 'BUSY' }, 'BUSY'],
    [{ cause: '17' }, 'BUSY'],
    [{ cause: '21' }, 'BUSY'],
    [{ cause: '20' }, 'UNREACHABLE'],
    [{ cause: '27' }, 'UNREACHABLE'],
    [{ cause: '26' }, 'UNANSWERED'],
    [{ cause: '1' }, 'FAILURE'],
    [{ cause: '28' }, 'FAILURE'],
    [{ cause: '34' }, 'NETWORK_ERROR'],
    [{ cause: 3 }, 'NETWORK_ERROR'],
    [{ disposition: 'CONGESTION' }, 'NETWORK_ERROR'],
    [{ disposition: 'FAILED' }, 'FAILURE'],
    [{ disposition: 'BUSY' }, 'BUSY'],
    [{ disposition: 'ANSWERED', answered: true }, 'ANSWERED'],
    [{ answered: true, cause: '38' }, 'DROPPED'],
    [{ answered: true, cause: '16' }, 'ANSWERED'],
    [{ answered: true, voicemail: true }, 'VOICEMAIL'], // voicemail is not a conversation
    [{ abandoned: true, cause: '16' }, 'ABANDONED'],
    [{}, 'FAILURE'],
  ];
  it.each(cases)('%j -> %s', (signals, expected) => {
    expect(mapCallOutcome(signals)).toBe(expected);
  });
});

// Live CEL HANGUP facts (asteriskcdrdb.cel ids 4/6/8, 23/25, 32), as celHangupsByLinkedid
// returns them.
const BUSY_CALL: CelFacts = {
  'PJSIP/100-00000000': { cause: '17', source: 'PJSIP/100-00000000', dialstatus: '', seq: 4 },
  'Local/100@from-internal-00000000;1': { cause: '0', source: '', dialstatus: '', seq: 6 },
  'Local/100@from-internal-00000000;2': { cause: '17', source: '', dialstatus: 'BUSY', seq: 8 },
};
const NEVER_DIALLED: CelFacts = {
  'Local/100@from-internal-00000002;1': { cause: '0', source: '', dialstatus: '', seq: 23 },
  'Local/100@from-internal-00000002;2': { cause: '16', source: 'dialplan/builtin', dialstatus: '', seq: 25 },
};
const FEATURE_CODE: CelFacts = {
  'PJSIP/100-00000002': { cause: '16', source: 'PJSIP/100-00000002', dialstatus: '', seq: 32 },
};

describe('outcomeFromCel on live rows', () => {
  it('1792247515.0: Dial to a busy 100 is BUSY (the old CDR-only mapping agreed)', () => {
    const cdr = {
      linkedid: '1792247515.0', disposition: 'BUSY', billsec: 0, lastapp: 'Dial', call_type: 'INTERNAL',
      channel: 'Local/100@from-internal-00000000;2', last_channel: 'Local/100@from-internal-00000000;2',
      dstchannel: 'PJSIP/100-00000000',
    };
    expect(outcomeFromCel(cdr, BUSY_CALL)).toBe('BUSY');
    expect(callEndedBy(cdr.channel, cdr.dstchannel, BUSY_CALL, false)).toEqual({ ended_by: 'agent', ended_by_agent: '100' });
  });

  it('1792251980.10: the *43 test call is ANSWERED, ended by agent 100', () => {
    const cdr = {
      disposition: 'ANSWERED', billsec: 3, lastapp: 'BackGround', call_type: 'INTERNAL',
      channel: 'PJSIP/100-00000002', last_channel: 'PJSIP/100-00000002', dstchannel: '',
    };
    expect(outcomeFromCel(cdr, FEATURE_CODE)).toBe('ANSWERED');
    expect(callEndedBy(cdr.channel, cdr.dstchannel, FEATURE_CODE, true)).toEqual({ ended_by: 'agent', ended_by_agent: '100' });
  });

  it('1792247552.8: a call that never reached a phone is MISSED, not the "Busy" OpDesk rang the bell with', () => {
    // cause 0 on ;1 is skipped (no cause), 16 from the dialplan on ;2 decides.
    const cdr = { disposition: 'NO ANSWER', billsec: 0, call_type: 'INTERNAL',
      channel: 'Local/100@from-internal-00000002;1', dstchannel: 'Local/100@from-internal-00000002;2' };
    expect(outcomeFromCel(cdr, NEVER_DIALLED)).toBe('MISSED');
    // dialplan/builtin names no one and no leg named a source: CEL has no say.
    expect(callEndedBy(cdr.channel, cdr.dstchannel, NEVER_DIALLED, false)).toEqual({});
  });

  it('falls back to the CDR disposition without CEL', () => {
    expect(outcomeFromCel({ disposition: 'NO ANSWER', billsec: 0 }, {})).toBe('UNANSWERED');
    expect(outcomeFromCel({ disposition: 'ANSWERED', billsec: 12 }, {})).toBe('ANSWERED');
    expect(outcomeFromCel({ disposition: 'ANSWERED', billsec: 12, lastapp: 'VoiceMail' }, {})).toBe('VOICEMAIL');
  });

  it('reads DIALSTATUS from the LAST leg caller channel (last_channel), not the first', () => {
    const facts: CelFacts = {
      'PJSIP/trunk1-00000001': { cause: '16', source: 'PJSIP/trunk1-00000001', dialstatus: '', seq: 1 },
      'PJSIP/101-00000002': { cause: '0', source: '', dialstatus: 'CANCEL', seq: 2 },
    };
    const cdr = { disposition: 'NO ANSWER', billsec: 0, call_type: 'OUT', channel: 'PJSIP/999-00000000',
      last_channel: 'PJSIP/101-00000002', dstchannel: 'PJSIP/trunk1-00000001' };
    expect(outcomeFromCel(cdr, facts)).toBe('UNANSWERED');
  });
});

describe('callEndedBy', () => {
  it('Dial() timer ran out: the system', () => {
    const facts: CelFacts = {
      'PJSIP/trunk-1': { cause: '16', source: '', dialstatus: 'NOANSWER', seq: 2 },
      'PJSIP/101-2': { cause: '', source: '', dialstatus: '', seq: 1 },
    };
    expect(callEndedBy('PJSIP/trunk-1', 'PJSIP/101-2', facts, false)).toEqual({ ended_by: 'system' });
  });

  it('caller gave up (CANCEL) on an inbound call: the customer', () => {
    const facts: CelFacts = {
      'PJSIP/trunk-1': { cause: '16', source: 'PJSIP/trunk-1', dialstatus: 'CANCEL', seq: 2 },
      'PJSIP/101-2': { cause: '16', source: 'dialplan/builtin', dialstatus: '', seq: 1 },
    };
    expect(callEndedBy('PJSIP/trunk-1', 'PJSIP/101-2', facts, false)).toEqual({ ended_by: 'customer' });
  });

  it('answered: whoever hung up first, ignoring dialplan teardown', () => {
    const facts: CelFacts = {
      'Local/101@from-queue-1;1': { cause: '16', source: 'dialplan/builtin', dialstatus: '', seq: 1 },
      'PJSIP/101-2': { cause: '16', source: 'PJSIP/101-2', dialstatus: '', seq: 2 },
      'PJSIP/trunk-1': { cause: '16', source: 'PJSIP/101-2', dialstatus: 'ANSWER', seq: 3 },
    };
    expect(callEndedBy('PJSIP/trunk-1', 'PJSIP/101-2', facts, true)).toEqual({ ended_by: 'agent', ended_by_agent: '101' });
  });

  it('no CEL: no verdict', () => {
    expect(callEndedBy('a', 'b', {}, true)).toEqual({});
  });

  it('channelParty', () => {
    expect(channelParty('PJSIP/1001-0000000a')).toEqual(['agent', '1001']);
    expect(channelParty('Local/1001@from-queue-00000001;1')).toEqual(['agent', '1001']);
    expect(channelParty('PJSIP/trunk1-00000001')).toEqual(['customer', null]);
    expect(channelParty('Local/s@custom-1;2')).toEqual(['system', null]);
    expect(channelParty('')).toEqual([null, null]);
  });
});
