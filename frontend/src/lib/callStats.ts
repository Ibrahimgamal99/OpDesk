// Live WebRTC media-quality sampling for the active call, derived from
// RTCPeerConnection.getStats(). Ported from the vopx softphone so the web
// softphone can show latency / jitter / signal strength while a call is up,
// and report a final sample (+ MOS) to the backend on hangup.

// Any field may be null when the browser hasn't reported it yet (e.g. before
// the first RTCP report arrives).
export interface CallStats {
  mos: number | null;            // estimated Mean Opinion Score, 1.0–5.0
  jitterMs: number | null;       // inbound jitter, milliseconds
  packetLossPct: number | null;  // cumulative inbound packet loss, %
  rttMs: number | null;          // round-trip time (latency), milliseconds
}

// estimateMos approximates a Mean Opinion Score from latency, jitter and loss
// using the ITU-T E-model (R-factor → MOS), the standard VoIP quality estimate.
function estimateMos(rttMs: number, jitterMs: number, lossPct: number): number {
  // One-way "effective latency" with jitter weighted (it hurts more than RTT).
  const effLatency = rttMs / 2 + jitterMs * 2 + 10;
  let r = 93.2;
  r -= effLatency < 160 ? effLatency / 40 : (effLatency - 120) / 10;
  r -= lossPct * 2.5; // each 1% loss costs ~2.5 R points
  if (r < 0) r = 0;
  const mos = 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6;
  return Math.max(1, Math.min(5, Math.round(mos * 10) / 10));
}

// computeCallStats reads one getStats() sample off a peer connection and reduces
// it to the inbound audio quality figures the UI shows.
/**
 * The subset of RTCStats this reads. Declared locally because it mixes
 * standard fields with vendor ones (`mediaType`, `roundTripTime` on
 * remote-inbound-rtp) that lib.dom's RTCStats does not carry.
 */
interface RtcStatsEntry {
  type?: string;
  kind?: string;
  mediaType?: string;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  roundTripTime?: number;
  currentRoundTripTime?: number;
  /** candidate-pair only; `selected` is the Firefox spelling of `nominated`. */
  nominated?: boolean;
  selected?: boolean;
}

export async function computeCallStats(pc: RTCPeerConnection | null | undefined): Promise<CallStats | null> {
  if (!pc) return null;
  let report: RTCStatsReport;
  try { report = await pc.getStats(); } catch { return null; }

  let jitterMs: number | null = null;
  let rttMs: number | null = null;
  let packetsLost = 0;
  let packetsReceived = 0;
  let sawInbound = false;

  report.forEach((s: RtcStatsEntry) => {
    if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
      sawInbound = true;
      if (typeof s.jitter === 'number') jitterMs = s.jitter * 1000;
      if (typeof s.packetsLost === 'number') packetsLost = s.packetsLost;
      if (typeof s.packetsReceived === 'number') packetsReceived = s.packetsReceived;
    }
    if (s.type === 'remote-inbound-rtp' && typeof s.roundTripTime === 'number') {
      rttMs = s.roundTripTime * 1000;
    }
    if (s.type === 'candidate-pair' && (s.nominated || s.selected) && typeof s.currentRoundTripTime === 'number') {
      if (rttMs == null) rttMs = s.currentRoundTripTime * 1000;
    }
  });

  if (!sawInbound) return null;

  let lossPct: number | null = null;
  const total = packetsLost + packetsReceived;
  if (total > 0) lossPct = Math.max(0, (packetsLost / total) * 100);

  const mos = estimateMos(rttMs ?? 0, jitterMs ?? 0, lossPct ?? 0);
  return { mos, jitterMs, packetLossPct: lossPct, rttMs };
}
