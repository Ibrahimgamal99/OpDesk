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
  /** Called when a call is established with the local (mic) stream, or with null when the call ends (so UI stops showing mic in use). */
  onLocalStream?: (stream: MediaStream | null) => void;
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
  /** Local hold state (SIP re-INVITE sendonly). */
  private holdState: boolean = false;
  private stopping: boolean = false;
  private onVisibilityChange: (() => void) | null = null;

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

  /**
   * Wire up early media from a 183 Session Progress response so the real SIP trunk
   * ringback tone plays instead of the local dialing.wav fallback.
   * Attaches a `track` listener to the peer connection; cleans itself up on Established/Terminated.
   */
  private listenForEarlyMedia(session: Session, onStream: (stream: MediaStream) => void): void {
    const sdh = session.sessionDescriptionHandler as { peerConnection?: RTCPeerConnection } | undefined;
    const pc = sdh?.peerConnection;
    if (!pc) return;

    let fired = false;
    const tracked = new Set<MediaStreamTrack>();

    // Only surface the remote stream once real RTP is actually flowing. A receiver
    // track exists immediately after the local offer but stays `muted` until the
    // carrier's early-media answer (183 w/ SDP) is applied and packets arrive.
    // Firing on the still-muted track would stop the local dialing tone and play
    // silence — so we wait for the track's `unmute` event before switching over.
    const fire = (track: MediaStreamTrack) => {
      if (fired) return;
      fired = true;
      onStream(new MediaStream([track]));
    };

    const watch = (track: MediaStreamTrack | null) => {
      if (!track || tracked.has(track)) return;
      tracked.add(track);
      if (!track.muted) {
        fire(track);
        return;
      }
      track.addEventListener('unmute', () => fire(track), { once: true });
    };

    pc.getReceivers().forEach((r) => watch(r.track));
    const onTrack = (event: RTCTrackEvent) => watch(event.track);
    pc.addEventListener('track', onTrack);

    // Remove listener once the call transitions out of the early-media phase.
    const cleanup = (state: SessionState) => {
      if (state === SessionState.Established || state === SessionState.Terminated) {
        pc.removeEventListener('track', onTrack);
      }
    };
    session.stateChange.addListener(cleanup);
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
    this.callbacks.onLocalStream?.(null);
    this.callbacks.onCallDuration?.('');
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
    this.stopping = false;
    this.serverUrl = server.trim();
    this.domain = parseDomain(this.serverUrl);
    this.updateStatus('connecting');
    this.log(`Connecting to ${this.serverUrl}...`, 'info');

    try {
      const uri = UserAgent.makeURI(`sip:${username}@${this.domain}`);
      if (!uri) throw new Error('Failed to create URI');

      const configuration: UserAgentOptions = {
        uri,
        transportOptions: {
          server: this.serverUrl,
          // Ping every 25 s to keep the WebSocket alive on mobile — without this,
          // iOS/Android kill idle connections within ~30 s when the tab is backgrounded.
          keepAliveInterval: 25,
          connectionTimeout: 10,
        },
        authorizationUsername: username,
        authorizationPassword: password,
        // reconnectionAttempts defaults to 0 (we handle reconnect ourselves below
        // to avoid conflicting with the hook-level reconnect triggered by status changes).
        logLevel: 'error',
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: PEER_CONNECTION_CONFIG,
        },
      };

      this.userAgent = new UserAgent(configuration);
      this.userAgent.delegate = {
        onConnect: () => {
          // Transport (re)connected — re-register so the PBX can reach this extension.
          this.log('Transport connected, re-registering...', 'info');
          this.registerer?.register().catch((err) => {
            this.log(`Re-registration failed: ${err}`, 'error');
          });
        },
        onDisconnect: (error?: Error) => {
          if (this.stopping) return;
          if (error) {
            // Unexpected drop (e.g. mobile OS killed the WebSocket).
            // Set status to 'connecting' so the hook-level reconnect guard (statusRef)
            // prevents App.tsx from creating a new WebPhone while we try a fast transport
            // reconnect here. If that fails we fall back to 'disconnected' so App.tsx
            // takes over and creates a fresh connection.
            this.updateStatus('connecting');
            this.log(`Transport disconnected: ${error.message}. Reconnecting...`, 'warn');
            this.userAgent?.reconnect().catch(() => {
              if (!this.stopping) {
                this.log('Reconnect failed — resetting connection', 'warn');
                this.updateStatus('disconnected');
              }
            });
          } else {
            // Clean close from the server — not retrying.
            this.updateStatus('disconnected');
          }
        },
        onInvite: (invitation: Invitation) => {
          // Reject if already in a call (busy).
          if (this.session) {
            this.log('Incoming call rejected — already in a call', 'warn');
            invitation.reject({ statusCode: 486 }).catch(() => {});
            return;
          }
          this.log('Incoming call...', 'info');
          this.session = invitation;
          this.setCallStatus('Incoming call...');
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

      this.registerer = new Registerer(this.userAgent, { expires: 300 });
      this.registerer.stateChange.addListener((state) => {
        if (state === RegistererState.Registered) {
          this.updateStatus('connected');
          this.log('Registered successfully', 'success');
          this.callbacks.onRegistered?.();
        } else if (state === RegistererState.Unregistered) {
          if (!this.stopping) this.updateStatus('disconnected');
          this.callbacks.onUnregistered?.();
        }
      });

      // When the tab comes back to the foreground: if the 25-s keepalive kept the
      // transport alive, just refresh the registration. If the transport died while
      // backgrounded, reconnect immediately (before App.tsx's 3-s WS reconnect fires).
      this.onVisibilityChange = () => {
        if (document.visibilityState !== 'visible' || this.stopping) return;
        const ua = this.userAgent;
        if (!ua) return;
        if (ua.transport.isConnected()) {
          this.registerer?.register().catch(() => {});
        } else {
          this.updateStatus('connecting');
          ua.reconnect().catch(() => {
            if (!this.stopping) this.updateStatus('disconnected');
          });
        }
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);

      await this.userAgent.start();
      await this.registerer.register();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Connection error: ${message}`, 'error');
      this.updateStatus('error');
    }
  }

  disconnect(): void {
    this.stopping = true;
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    if (this.session) this.hangup();
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

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
        // Apply the SDP answer from a provisional response (183 Session Progress)
        // so carrier-provided ringback (early media) plays. Without this, SIP.js
        // ignores the early SDP for an INVITE-with-offer and no early-media RTP
        // ever flows. Assumes the INVITE does not fork (single PBX/trunk), which
        // holds for this softphone's setup.
        earlyMedia: true,
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
            // Attempt to grab early media (183 Session Progress with SDP).
            // If the SIP trunk streams real ringback audio, this fires onRemoteStream
            // so the local dialing.wav fallback stops and the real tone plays.
            this.listenForEarlyMedia(inviter, onRemoteStream);
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
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
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
