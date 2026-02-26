import React, { createContext, useContext, type ReactNode } from 'react';
import type { WebRtcConfig } from '../hooks/useWebPhone';
import type { WebPhoneStatus, IncomingCallInfo } from '../lib/webPhone';

export interface WebPhoneContextValue {
  config: WebRtcConfig | null;
  configLoading: boolean;
  configError: string | null;
  status: WebPhoneStatus;
  callStatus: string;
  callDuration: string;
  logs: Array<{ message: string; type: 'info' | 'success' | 'warn' | 'error'; time: string }>;
  incomingCall: IncomingCallInfo | null;
  activeCallRemoteNumber: string;
  activeCallRemoteName: string;
  dialNumber: string;
  setDialNumber: React.Dispatch<React.SetStateAction<string>>;
  canConnect: boolean;
  isConnected: boolean;
  hasActiveCall: boolean;
  isCallAnswered: boolean;
  isOutgoingRinging: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  makeCall: () => void;
  hangup: () => void;
  addDigit: (digit: string) => void;
  clearNumber: () => void;
  backspace: () => void;
  clearLogs: () => void;
  refetchConfig: () => Promise<void>;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  toggleMute: () => void;
  isOnHold: boolean;
  toggleHold: () => void;
  transfer: (destination: string) => Promise<void> | void;
}

const WebPhoneContext = createContext<WebPhoneContextValue | null>(null);

export function WebPhoneProvider({
  value,
  children,
}: {
  value: WebPhoneContextValue;
  children: ReactNode;
}) {
  return (
    <WebPhoneContext.Provider value={value}>
      {children}
    </WebPhoneContext.Provider>
  );
}

export function useWebPhoneContext(): WebPhoneContextValue {
  const ctx = useContext(WebPhoneContext);
  if (!ctx) throw new Error('useWebPhoneContext must be used within WebPhoneProvider');
  return ctx;
}
