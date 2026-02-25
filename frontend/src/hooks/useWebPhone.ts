import { useState, useCallback, useRef, useEffect } from 'react';
import { WebPhone, type WebPhoneStatus, type WebPhoneCallbacks, type IncomingCallInfo } from '../lib/webPhone';
import { getAuthHeaders } from '../auth';

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
  const [dialNumber, setDialNumber] = useState('');
  const phoneRef = useRef<WebPhone | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const dialingRef = useRef<HTMLAudioElement | null>(null);
  const hasActiveCallRef = useRef(false);

  const fetchConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await fetch('/api/webrtc/config', { headers: getAuthHeaders() });
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
  };

  const connect = useCallback(async () => {
    if (!config?.server?.trim() || !config?.extension?.trim() || !config?.extension_secret?.trim()) {
      addLog('Set PBX server (admin), extension and extension secret first', 'error');
      return;
    }
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
    phone.makeCall(dialNumber.trim(), (stream) => setRemoteStream(stream));
  }, [dialNumber]);

  const hangup = useCallback(() => {
    phoneRef.current?.hangup();
    setRemoteStream(null);
    setLocalStream(null);
    setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    phoneRef.current?.toggleMute();
  }, []);

  const addDigit = useCallback((digit: string) => {
    setDialNumber((prev) => prev + digit);
    if (phoneRef.current?.hasActiveCall) phoneRef.current.sendDTMF(digit);
  }, []);

  const clearNumber = useCallback(() => setDialNumber(''), []);

  const backspace = useCallback(() => {
    setDialNumber((prev) => prev.slice(0, -1));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  useEffect(() => {
    if (remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  // Incoming call: play ringtone until answer/reject
  useEffect(() => {
    if (incomingCall) {
      const audio = new Audio('/sounds/ringtone.wav');
      audio.loop = true;
      ringtoneRef.current = audio;
      audio.play().catch(() => {});
      return () => {
        audio.pause();
        audio.currentTime = 0;
        ringtoneRef.current = null;
      };
    }
    ringtoneRef.current = null;
  }, [incomingCall]);

  const isOutgoingRinging =
    callStatus.startsWith('Calling ') || callStatus === 'Ringing...';

  // Outgoing call: play dialing (ringback) while "Calling..." or "Ringing..."
  useEffect(() => {
    if (isOutgoingRinging) {
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
    dialingRef.current = null;
  }, [isOutgoingRinging]);

  useEffect(() => {
    return () => {
      phoneRef.current?.disconnect();
      phoneRef.current = null;
      ringtoneRef.current?.pause();
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
      setLocalStream(null);
      setIsMuted(false);
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
    refetchConfig: fetchConfig,
    remoteAudioRef,
    localStream,
    remoteStream,
    isMuted,
    toggleMute,
  };
}
