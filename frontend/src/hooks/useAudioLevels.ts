import { useState, useEffect, useRef } from 'react';

const SMOOTHING = 0.7;
const FFT_SIZE = 256;
const MIN_LEVEL = 0.02;
const LEVEL_SCALE = 2.5;

function useStreamLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return () => {};
    }

    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    ctxRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    sourceRef.current = source;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    analyserRef.current = analyser;

    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    dataArrayRef.current = dataArray;

    let lastLevel = 0;

    const tick = () => {
      if (!analyserRef.current || !dataArrayRef.current) return;
      const data = dataArrayRef.current;
      if (data) analyserRef.current.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
      const sum = dataArrayRef.current.reduce((a, b) => a + b, 0);
      const average = sum / bufferLength / 255;
      const normalized = Math.min(1, Math.max(0, average * LEVEL_SCALE));
      const smoothed = lastLevel * SMOOTHING + normalized * (1 - SMOOTHING);
      lastLevel = smoothed;
      setLevel(smoothed < MIN_LEVEL ? 0 : smoothed);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      try {
        audioContext.close();
      } catch {
        // ignore
      }
      ctxRef.current = null;
      sourceRef.current = null;
      analyserRef.current = null;
      dataArrayRef.current = null;
      setLevel(0);
    };
  }, [stream]);

  return level;
}

export function useAudioLevels(
  localStream: MediaStream | null,
  remoteStream: MediaStream | null
): { micLevel: number; speakerLevel: number } {
  const micLevel = useStreamLevel(localStream);
  const speakerLevel = useStreamLevel(remoteStream);
  return { micLevel, speakerLevel };
}
