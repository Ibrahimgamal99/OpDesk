/**
 * WebPhone: SIP.js 0.21.x softphone logic (no DOM).
 * Mirrors webrtc.js behavior: connect with server/extension/secret, register, make/answer/hangup calls, DTMF.
 */

import {
  UserAgent,
  Registerer,
  Inviter,
  Invitation,
  RegistererState,
  SessionState,
  Session,
  Web,
} from 'sip.js';
import type { UserAgentOptions } from 'sip.js';
import type { InviterOptions } from 'sip.js';
import type { InvitationAcceptOptions } from 'sip.js';

export type WebPhoneStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type CallStatus = '' | 'dialing' | 'ringing' | 'in_call' | 'incoming' | 'error';

export interface IncomingCallInfo {
  callerNumber: string;
  callerName: string;
  accept: () => void;
  reject: () => void;
}

export interface WebPhoneCallbacks {
  onStatus?: (status: WebPhoneStatus) => void;
  onLog?: (message: string, type: 'info' | 'success' | 'warn' | 'error') => void;
  onCallStatus?: (text: string) => void;
  onCallDuration?: (text: string) => void;
  onRegistered?: () => void;
  onUnregistered?: () => void;
  onIncomingCall?: (info: IncomingCallInfo) => void;
  /** Called when an incoming call ends before answer (caller hung up or cancelled). */
  onIncomingCallEnded?: () => void;
  /** Called when a call is established with the local (mic) stream for level metering. */
  onLocalStream?: (stream: MediaStream) => void;
  /** Called when mute state changes (true = muted). */
  onMutedChange?: (muted: boolean) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

/** Max ms to wait for ICE gathering before sending INVITE (reduces call setup delay). */
const ICE_GATHERING_TIMEOUT_MS = 800;

const PEER_CONNECTION_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 1, // Pre-gather candidates for faster setup
};

function parseDomain(server: string): string {
  let domain = server.replace('wss://', '').replace('ws://', '');
  if (domain.includes('/')) domain = domain.split('/')[0];
  if (domain.includes(':')) domain = domain.split(':')[0];
  return domain;
}

export class WebPhone {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Inviter | Invitation | null = null;
  private localStream: MediaStream | null = null;
  private callStartTime: number | null = null;
  private callTimer: ReturnType<typeof setInterval> | null = null;
  private callbacks: WebPhoneCallbacks;
  private serverUrl: string = '';
  private domain: string = '';
  /** Pre-acquired mic stream after connect so first call skips getUserMedia delay. */
  private preacquiredStream: MediaStream | null = null;
  /** Local hold state (SIP re-INVITE sendonly). */
  private holdState: boolean = false;

  constructor(callbacks: WebPhoneCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.registerer?.state === RegistererState.Registered;
  }

  get hasActiveCall(): boolean {
    return this.session != null;
  }

  /** Mute/unmute the microphone for the current call. Toggles if no argument. */
  setMuted(muted: boolean): void {
    if (!this.localStream) return;
    const tracks = this.localStream.getAudioTracks();
    if (tracks.length === 0) return;
    tracks.forEach((t) => { t.enabled = !muted; });
    this.callbacks.onMutedChange?.(muted);
    // Also disable the track on the peer connection senders (same track ref, but ensure no send)
    const sdh = this.session?.sessionDescriptionHandler as { peerConnection?: RTCPeerConnection };
    const pc = sdh?.peerConnection;
    if (pc) {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'audio') sender.track.enabled = !muted;
      });
    }
  }

  toggleMute(): boolean {
    if (!this.localStream) return false;
    const tracks = this.localStream.getAudioTracks();
    if (tracks.length === 0) return false;
    const nextMuted = tracks[0].enabled;
    this.setMuted(nextMuted);
    return nextMuted;
  }

  get isMuted(): boolean {
    if (!this.localStream) return false;
    const tracks = this.localStream.getAudioTracks();
    return tracks.length > 0 && !tracks[0].enabled;
  }

  private log(message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
    this.callbacks.onLog?.(message, type);
  }

  private updateStatus(status: WebPhoneStatus) {
    this.callbacks.onStatus?.(status);
  }

  private setCallStatus(text: string) {
    this.callbacks.onCallStatus?.(text);
  }

  private setCallDuration(text: string) {
    this.callbacks.onCallDuration?.(text);
  }

  private startCallTimer() {
    this.callStartTime = Date.now();
    this.callTimer = setInterval(() => {
      if (this.callStartTime == null) return;
      const duration = Math.floor((Date.now() - this.callStartTime) / 1000);
      const m = Math.floor(duration / 60);
      const s = duration % 60;
      this.setCallDuration(`${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    }, 1000);
  }

  private stopCallTimer() {
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }
    this.callStartTime = null;
    this.setCallDuration('');
  }

  private setupRemoteMedia(session: Session, onRemoteStream: (stream: MediaStream) => void) {
    const sdh = session.sessionDescriptionHandler as { peerConnection?: RTCPeerConnection };
    if (!sdh?.peerConnection) {
      setTimeout(() => this.setupRemoteMedia(session, onRemoteStream), 200);
      return;
    }
    const pc = sdh.peerConnection;
    const receivers = pc.getReceivers();
    if (receivers.length === 0) {
      setTimeout(() => this.setupRemoteMedia(session, onRemoteStream), 200);
      return;
    }
    const remoteStream = new MediaStream();
    receivers.forEach((r) => {
      if (r.track) remoteStream.addTrack(r.track);
    });
    if (remoteStream.getTracks().length > 0) onRemoteStream(remoteStream);
  }

  private resetCallState() {
    this.session = null;
    this.holdState = false;
    this.setCallStatus('');
    this.stopCallTimer();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.callbacks.onCallDuration?.('');
    if (this.isConnected) this.acquireMicrophoneForCalls();
  }

  /** True if the current call is on hold (SIP re-INVITE sendonly). */
  get isOnHold(): boolean {
    return this.holdState;
  }

  /**
   * Put the current call on hold via SIP re-INVITE (sendonly), like MicroSIP.
   * No AMI MusicOnHold; the remote party hears silence (or the SIP server may play MOH).
   */
  async hold(): Promise<void> {
    const s = this.session;
    if (!s || s.state !== SessionState.Established) {
      this.log('No active call to hold', 'warn');
      return;
    }
    try {
      await s.invite({ sessionDescriptionHandlerModifiers: [Web.holdModifier] });
      this.holdState = true;
      this.log('Call on hold', 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Hold failed: ${message}`, 'error');
      throw err;
    }
  }

  /**
   * Resume the call from hold (re-INVITE with sendrecv).
   */
  async unhold(): Promise<void> {
    const s = this.session;
    if (!s || s.state !== SessionState.Established) {
      this.log('No active call to unhold', 'warn');
      return;
    }
    try {
      await s.invite({ sessionDescriptionHandlerModifiers: [] });
      this.holdState = false;
      this.log('Call resumed', 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Unhold failed: ${message}`, 'error');
      throw err;
    }
  }

  /**
   * Blind transfer the current call via SIP REFER (like MicroSIP). No AMI Redirect.
   * @param destination - Extension or number (e.g. "201")
   */
  async refer(destination: string): Promise<void> {
    const s = this.session;
    if (!s || s.state !== SessionState.Established) {
      this.log('No active call to transfer', 'warn');
      throw new Error('No active call');
    }
    const dest = destination.trim();
    if (!dest) {
      this.log('Transfer destination is required', 'warn');
      throw new Error('Destination required');
    }
    const targetUri = UserAgent.makeURI(`sip:${dest}@${this.domain}`);
    if (!targetUri) {
      this.log('Invalid transfer destination', 'error');
      throw new Error('Invalid destination');
    }
    try {
      await s.refer(targetUri);
      this.log(`Transfer to ${dest} sent`, 'success');
      // Hang up our leg so the source channel is released (server may not send BYE to us).
      // Brief delay so the REFER is processed before BYE; avoids races on some servers.
      await new Promise((r) => setTimeout(r, 400));
      this.hangup();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Transfer failed: ${message}`, 'error');
      throw err;
    }
  }

  async connect(server: string, username: string, password: string): Promise<void> {
    if (!server?.trim() || !username?.trim() || !password?.trim()) {
      this.log('Server, extension and secret are required', 'error');
      this.updateStatus('error');
      return;
    }
    this.serverUrl = server.trim();
    this.domain = parseDomain(this.serverUrl);
    this.updateStatus('connecting');
    this.log(`Connecting to ${this.serverUrl}...`, 'info');

    try {
      const uri = UserAgent.makeURI(`sip:${username}@${this.domain}`);
      if (!uri) throw new Error('Failed to create URI');

      const configuration: UserAgentOptions = {
        uri,
        transportOptions: { server: this.serverUrl },
        authorizationUsername: username,
        authorizationPassword: password,
        logLevel: 'error',
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: PEER_CONNECTION_CONFIG,
        },
      };

      this.userAgent = new UserAgent(configuration);
      this.userAgent.delegate = {
        onInvite: (invitation: Invitation) => {
          this.log('Incoming call...', 'info');
          this.session = invitation;
          this.setCallStatus('Incoming call...');
          // When caller hangs up or cancels before we answer, clear incoming UI and stop ringtone
          invitation.stateChange.addListener((state) => {
            if (state === SessionState.Terminated) {
              this.resetCallState();
              this.callbacks.onIncomingCallEnded?.();
            }
          });
          invitation.delegate = {
            onBye: () => {
              this.log('Incoming call ended by caller', 'info');
              this.resetCallState();
              this.callbacks.onIncomingCallEnded?.();
            },
          };
          const ri = invitation.remoteIdentity;
          const callerNumber = (ri?.uri?.user ?? ri?.uri?.toString() ?? 'Unknown').toString();
          const callerName = (ri?.displayName?.trim() || ri?.friendlyName?.trim()) ?? '';
          this.callbacks.onIncomingCall?.({
            callerNumber,
            callerName,
            accept: () => this.answerIncomingCall(invitation),
            reject: () => {
              invitation.reject();
              this.resetCallState();
            },
          });
        },
      };

      this.registerer = new Registerer(this.userAgent, { expires: 600 });
      this.registerer.stateChange.addListener((state) => {
        if (state === RegistererState.Registered) {
          this.updateStatus('connected');
          this.log('Registered successfully', 'success');
          this.callbacks.onRegistered?.();
          this.acquireMicrophoneForCalls();
        } else if (state === RegistererState.Unregistered) {
          this.updateStatus('disconnected');
          this.callbacks.onUnregistered?.();
        }
      });

      await this.userAgent.start();
      await this.registerer.register();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Connection error: ${message}`, 'error');
      this.updateStatus('error');
    }
  }

  /** Pre-acquire microphone so first outgoing/incoming call does not wait for getUserMedia. */
  private acquireMicrophoneForCalls(): void {
    if (!navigator.mediaDevices?.getUserMedia || this.preacquiredStream?.active) return;
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((stream) => {
        if (this.preacquiredStream) {
          this.preacquiredStream.getTracks().forEach((t) => t.stop());
        }
        this.preacquiredStream = stream;
      })
      .catch(() => {});
  }

  disconnect(): void {
    if (this.session) this.hangup();
    if (this.preacquiredStream) {
      this.preacquiredStream.getTracks().forEach((t) => t.stop());
      this.preacquiredStream = null;
    }
    if (this.registerer) {
      this.registerer.unregister().catch(() => {});
      this.registerer = null;
    }
    if (this.userAgent) {
      this.userAgent.stop();
      this.userAgent = null;
    }
    this.updateStatus('disconnected');
    this.log('Disconnected', 'info');
    this.resetCallState();
  }

  sendDTMF(digit: string): void {
    const s = this.session?.sessionDescriptionHandler as { sendDtmf?: (d: string) => void };
    if (s?.sendDtmf) {
      try {
        s.sendDtmf(digit);
        this.log(`DTMF: ${digit}`, 'info');
      } catch (e) {
        this.log(`DTMF error: ${e}`, 'error');
      }
    }
  }

  async makeCall(
    number: string,
    onRemoteStream: (stream: MediaStream) => void
  ): Promise<void> {
    if (!number?.trim()) {
      this.log('Please enter a number', 'warn');
      return;
    }
    if (!this.isConnected || !this.userAgent) {
      this.log('Please connect first', 'error');
      return;
    }
    if (this.session) {
      this.log('A call is already in progress', 'warn');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.log('Microphone requires HTTPS or localhost', 'error');
      this.setCallStatus('Error');
      return;
    }

    const usePreacquired =
      this.preacquiredStream?.active &&
      this.preacquiredStream.getAudioTracks().some((t) => t.readyState === 'live');
    try {
      this.localStream = usePreacquired
        ? this.preacquiredStream
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
      if (!usePreacquired && this.preacquiredStream) {
        this.preacquiredStream.getTracks().forEach((t) => t.stop());
      }
      if (usePreacquired) this.preacquiredStream = null;
    } catch (e) {
      this.log('Microphone access denied', 'error');
      this.setCallStatus('Error');
      return;
    }

    this.setCallStatus(`Calling ${number}...`);
    this.log(`Calling ${number}...`, 'info');

    try {
      const targetUri = UserAgent.makeURI(`sip:${number}@${this.domain}`);
      if (!targetUri) throw new Error('Failed to create target URI');

      const inviterOptions: InviterOptions = {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
          mediaStream: this.localStream,
          peerConnectionConfiguration: PEER_CONNECTION_CONFIG,
          iceGatheringTimeout: ICE_GATHERING_TIMEOUT_MS,
        } as InviterOptions['sessionDescriptionHandlerOptions'],
      };

      const inviter = new Inviter(this.userAgent, targetUri, inviterOptions);
      this.session = inviter;

      inviter.delegate = {
        onBye: () => {
          this.log('Call ended by remote party', 'info');
          this.resetCallState();
        },
      };

      inviter.stateChange.addListener((state) => {
        switch (state) {
          case SessionState.Establishing:
            this.setCallStatus('Ringing...');
            break;
          case SessionState.Established:
            this.log('Call connected', 'success');
            this.setCallStatus(`In call with ${number}`);
            this.startCallTimer();
            this.setupRemoteMedia(inviter, onRemoteStream);
            if (this.localStream) this.callbacks.onLocalStream?.(this.localStream);
            break;
          case SessionState.Terminated:
            this.resetCallState();
            break;
          default:
            break;
        }
      });

      await inviter.invite();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Call error: ${message}`, 'error');
      this.setCallStatus('Call error');
      this.resetCallState();
    }
  }

  private async answerIncomingCall(
    invitation: Invitation,
    onRemoteStream?: (stream: MediaStream) => void
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      invitation.reject();
      this.resetCallState();
      return;
    }
    const usePreacquired =
      this.preacquiredStream?.active &&
      this.preacquiredStream.getAudioTracks().some((t) => t.readyState === 'live');
    try {
      this.localStream = usePreacquired
        ? this.preacquiredStream
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
      if (!usePreacquired && this.preacquiredStream) {
        this.preacquiredStream.getTracks().forEach((t) => t.stop());
      }
      if (usePreacquired) this.preacquiredStream = null;
    } catch {
      invitation.reject();
      this.resetCallState();
      return;
    }

    const opts: InvitationAcceptOptions = {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
        mediaStream: this.localStream,
        peerConnectionConfiguration: PEER_CONNECTION_CONFIG,
        iceGatheringTimeout: ICE_GATHERING_TIMEOUT_MS,
      } as InvitationAcceptOptions['sessionDescriptionHandlerOptions'],
    };

    invitation.delegate = {
      onBye: () => {
        this.log('Call ended by remote party', 'info');
        this.resetCallState();
      },
    };

    invitation.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        this.log('Call connected', 'success');
        this.setCallStatus('In call');
        this.startCallTimer();
        if (onRemoteStream) this.setupRemoteMedia(invitation, onRemoteStream);
        if (this.localStream) this.callbacks.onLocalStream?.(this.localStream);
      } else if (state === SessionState.Terminated) {
        this.resetCallState();
      }
    });

    await invitation.accept(opts);
  }

  acceptIncomingCall(onRemoteStream: (stream: MediaStream) => void): void {
    const inv = this.session instanceof Invitation ? this.session : null;
    if (inv) this.answerIncomingCall(inv, onRemoteStream);
  }

  rejectIncomingCall(): void {
    if (this.session instanceof Invitation) {
      this.session.reject();
    }
    this.resetCallState();
  }

  hangup(): void {
    if (this.session) {
      try {
        if (this.session.state === SessionState.Established) {
          this.session.bye();
        } else if ('cancel' in this.session && typeof this.session.cancel === 'function') {
          (this.session as Inviter).cancel();
        } else if ('reject' in this.session && typeof this.session.reject === 'function') {
          (this.session as Invitation).reject();
        }
      } catch {
        // ignore
      }
      this.session = null;
    }
    this.resetCallState();
  }
}
