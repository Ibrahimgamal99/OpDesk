import { useState, useCallback, useRef, useEffect } from 'react';
import { WebPhone, type WebPhoneStatus, type WebPhoneCallbacks, type IncomingCallInfo } from '../lib/webPhone';
import { fetchWithAuth } from '../auth';

// Minimal valid silent WAV (8-bit mono 8 kHz, ~100 samples) — used to unlock audio
// elements on mobile before any async operations break the user-gesture chain
// (iOS Safari autoplay policy). Must contain actual samples: a 0-sample data chunk
// decodes on Chrome/Safari but Firefox rejects it (NS_ERROR_DOM_MEDIA_METADATA_ERR),
// which left the audio element un-primed and the dialing/ringback tone silent.
const SILENT_WAV = 'data:audio/wav;base64,UklGRogAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWQAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

export interface WebRtcConfig {
  server: string;
  extension: string | null;
  extension_secret: string | null;
}

export function useWebPhone() {
  const [config, setConfig] = useState<WebRtcConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [status, setStatus] = useState<WebPhoneStatus>('disconnected');
  const [callStatus, setCallStatus] = useState('');
  const [callDuration, setCallDuration] = useState('');
  const [logs, setLogs] = useState<Array<{ message: string; type: 'info' | 'success' | 'warn' | 'error'; time: string }>>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  const [activeCallRemoteNumber, setActiveCallRemoteNumber] = useState('');
  const [activeCallRemoteName, setActiveCallRemoteName] = useState('');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isOnHold, setIsOnHold] = useState(false);
  const [dialNumber, setDialNumber] = useState('');
  const [lastDialedNumber, setLastDialedNumber] = useState<string>(
    () => localStorage.getItem('softphone_last_number') ?? ''
  );
  const phoneRef = useRef<WebPhone | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const dialingRef = useRef<HTMLAudioElement | null>(null);
  const hasActiveCallRef = useRef(false);
  const audioUnlockedRef = useRef(false);
  // Tracks the current status synchronously so connect() can guard against
  // interrupting a SIP.js transport reconnect that's already in progress.
  const statusRef = useRef<WebPhoneStatus>('disconnected');

  const fetchConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await fetchWithAuth('/api/webrtc/config');
      if (!res.ok) throw new Error('Failed to load WebRTC config');
      const data = await res.json();
      setConfig({
        server: data.server || '',
        extension: data.extension ?? null,
        extension_secret: data.extension_secret ?? null,
      });
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : 'Failed to load config');
      setConfig(null);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Unlock audio on first user gesture so ringtone/dialing sounds work on mobile.
  // Mobile browsers block programmatic audio until the page has had a user-activated
  // audio play (iOS Safari autoplay policy).
  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      audioUnlockedRef.current = true;
      const a = new Audio(SILENT_WAV);
      a.play().catch(() => {});
      // Pre-load sound files so they're ready when needed
      const preRingtone = new Audio('/sounds/ringtone.wav');
      preRingtone.load();
      const preDialing = new Audio('/sounds/dialing.wav');
      preDialing.load();
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, []);

  // Keep statusRef in sync so connect() can read the current status synchronously
  // without stale-closure issues (statusRef is updated before App.tsx effects run).
  useEffect(() => { statusRef.current = status; }, [status]);

  const addLog = useCallback((message: string, type: 'info' | 'success' | 'warn' | 'error') => {
    setLogs((prev) => [...prev.slice(-99), { message, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const callbacks: WebPhoneCallbacks = {
    onStatus: setStatus,
    onLog: addLog,
    onCallStatus: setCallStatus,
    onCallDuration: setCallDuration,
    onRegistered: () => setStatus('connected'),
    onUnregistered: () => setStatus('disconnected'),
    onLocalStream: setLocalStream,
    onMutedChange: setIsMuted,
    onIncomingCall: (info) => {
      setIncomingCall({
        callerNumber: info.callerNumber,
        callerName: info.callerName,
        accept: () => {
          setActiveCallRemoteNumber(info.callerNumber);
          setActiveCallRemoteName(info.callerName ?? '');
          setIncomingCall(null);
          const phone = phoneRef.current;
          if (phone) phone.acceptIncomingCall((stream) => setRemoteStream(stream));
        },
        reject: () => {
          setIncomingCall(null);
          phoneRef.current?.rejectIncomingCall();
          info.reject();
        },
      });
    },
    onIncomingCallEnded: () => setIncomingCall(null),
  };

  const connect = useCallback(async () => {
    if (!config?.server?.trim() || !config?.extension?.trim() || !config?.extension_secret?.trim()) {
      addLog('Set PBX server (admin), extension and extension secret first', 'error');
      return;
    }
    // Guard: if the existing WebPhone is already mid-reconnect (status = 'connecting'),
    // don't interrupt it. onDisconnect sets 'connecting' so this hook's callers
    // (App.tsx's auto-reconnect effect) don't race with SIP.js's transport reconnect.
    if (statusRef.current === 'connecting' && phoneRef.current) return;
    if (phoneRef.current) {
      phoneRef.current.disconnect();
      phoneRef.current = null;
    }
    const phone = new WebPhone(callbacks);
    phoneRef.current = phone;
    setRemoteStream(null);
    setLogs((prev) => [...prev, { message: 'Connecting...', type: 'info', time: new Date().toLocaleTimeString() }]);
    await phone.connect(config.server, config.extension, config.extension_secret);
  }, [config, addLog]);

  // Auto-connect once config is available and we are not already connected/connecting
  const canConnectRef = useRef(false);
  useEffect(() => {
    if (
      !configLoading &&
      !configError &&
      config?.server?.trim() &&
      config?.extension?.trim() &&
      config?.extension_secret?.trim() &&
      status === 'disconnected' &&
      !canConnectRef.current
    ) {
      canConnectRef.current = true;
      connect();
    }
  }, [configLoading, configError, config, status, connect]);

  const disconnect = useCallback(() => {
    if (phoneRef.current) {
      phoneRef.current.disconnect();
      phoneRef.current = null;
    }
    setStatus('disconnected');
    setCallStatus('');
    setCallDuration('');
    setIncomingCall(null);
    setRemoteStream(null);
  }, []);

  const makeCall = useCallback(() => {
    const phone = phoneRef.current;
    if (!phone) return;
    const target = dialNumber.trim() || lastDialedNumber;
    if (!target) return;
    if (target !== lastDialedNumber) {
      setLastDialedNumber(target);
      localStorage.setItem('softphone_last_number', target);
    }
    phone.makeCall(target, (stream) => setRemoteStream(stream));
  }, [dialNumber, lastDialedNumber]);

  const hangup = useCallback(() => {
    phoneRef.current?.hangup();
    setRemoteStream(null);
    setLocalStream(null);
    setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    phoneRef.current?.toggleMute();
  }, []);

  const holdMutedRef = useRef(false);

  const toggleHold = useCallback(async () => {
    const phone = phoneRef.current;
    if (!phone?.hasActiveCall) return;
    const next = !isOnHold;

    // Local mic: mute when putting on hold, restore when resuming (SIP hold is sendonly; this is extra)
    if (next) {
      holdMutedRef.current = !isMuted;
      if (!isMuted) phone.toggleMute();
    } else {
      if (holdMutedRef.current && isMuted) phone.toggleMute();
      holdMutedRef.current = false;
    }

    try {
      if (next) await phone.hold();
      else await phone.unhold();
      setIsOnHold(next);
    } catch {
      addLog('Hold action failed', 'error');
    }
  }, [isMuted, isOnHold, addLog]);

  const addDigit = useCallback((digit: string) => {
    setDialNumber((prev) => prev + digit);
    if (phoneRef.current?.hasActiveCall) phoneRef.current.sendDTMF(digit);
  }, []);

  const clearNumber = useCallback(() => setDialNumber(''), []);

  const backspace = useCallback(() => {
    setDialNumber((prev) => prev.slice(0, -1));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const transfer = useCallback(async (destination: string) => {
    const dest = destination.trim();
    if (!dest) return;
    try {
      await phoneRef.current?.refer(dest);
      addLog(`Transfer to ${dest} sent`, 'success');
    } catch {
      addLog('Transfer failed', 'error');
    }
  }, [addLog]);

  // Called synchronously in the Answer button click handler (before any awaits) to
  // unlock the remote audio element under iOS Safari's autoplay/user-gesture policy.
  // Without this, play() called later (after SIP/WebRTC negotiation awaits) is blocked.
  const unlockRemoteAudio = useCallback(() => {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    audio.src = SILENT_WAV;
    audio.play()
      .then(() => {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      })
      .catch(() => {
        audio.removeAttribute('src');
      });
  }, []);

  useEffect(() => {
    if (remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  // Incoming-call ringtone is handled by the AudioContext oscillator in App.tsx.

  const isOutgoingRinging =
    callStatus.startsWith('Calling ') || callStatus === 'Ringing...';

  // Outgoing call: play ringtone.wav as local ringback until the carrier sends
  // early media (183 with SDP). When remoteStream is set, the cleanup here stops
  // the local audio and the carrier ringback plays through remoteAudioRef.
  useEffect(() => {
    if (isOutgoingRinging && !remoteStream) {
      const audio = new Audio('/sounds/dialing.wav');
      audio.loop = true;
      dialingRef.current = audio;
      audio.play().catch(() => {});
      return () => {
        audio.pause();
        audio.currentTime = 0;
        dialingRef.current = null;
      };
    }
    // Early media arrived — stop local dialing tone so carrier ringback is heard.
    if (dialingRef.current) {
      dialingRef.current.pause();
      dialingRef.current.currentTime = 0;
      dialingRef.current = null;
    }
  }, [isOutgoingRinging, remoteStream]);

  useEffect(() => {
    return () => {
      phoneRef.current?.disconnect();
      phoneRef.current = null;
      dialingRef.current?.pause();
    };
  }, []);

  const canConnect =
    !configLoading &&
    !!config?.server?.trim() &&
    !!config?.extension?.trim() &&
    !!config?.extension_secret?.trim();
  const isConnected = status === 'connected';
  const hasActiveCall =
    !!incomingCall || (callStatus !== '' && callStatus !== 'Call error');
  const isCallAnswered =
    callStatus === 'In call' || callStatus.startsWith('In call with ');

  // When call is answered, clear incoming call state so we show in-call view
  useEffect(() => {
    if (isCallAnswered) setIncomingCall(null);
  }, [isCallAnswered]);

  // Clear active-call display and dial number when call ends
  useEffect(() => {
    if (!hasActiveCall) {
      setActiveCallRemoteNumber('');
      setActiveCallRemoteName('');
      setDialNumber('');
      setRemoteStream(null);
      setLocalStream(null);
      setIsMuted(false);
      setIsOnHold(false);
      holdMutedRef.current = false;
    }
  }, [hasActiveCall]);

  // Call ended: play hangup once when we had a call and now we don't
  useEffect(() => {
    const hadCall = hasActiveCallRef.current;
    hasActiveCallRef.current = hasActiveCall;
    if (hadCall && !hasActiveCall) {
      const audio = new Audio('/sounds/hangup.wav');
      audio.play().catch(() => {});
    }
  }, [hasActiveCall]);

  return {
    config,
    configLoading,
    configError,
    status,
    callStatus,
    callDuration,
    logs,
    incomingCall,
    activeCallRemoteNumber,
    activeCallRemoteName,
    dialNumber,
    setDialNumber,
    lastDialedNumber,
    canConnect,
    isConnected,
    hasActiveCall,
    isCallAnswered,
    isOutgoingRinging,
    connect,
    disconnect,
    makeCall,
    hangup,
    addDigit,
    clearNumber,
    backspace,
    clearLogs,
    transfer,
    refetchConfig: fetchConfig,
    remoteAudioRef,
    localStream,
    remoteStream,
    isMuted,
    toggleMute,
    isOnHold,
    toggleHold,
    unlockRemoteAudio,
  };
}
