import { useRef, useEffect } from 'react';

const BARS = 14;
const BAR_W = 4;
const GAP = 2;
const CANVAS_W = BARS * (BAR_W + GAP) - GAP;
const CANVAS_H = 16;

/**
 * Pixel-style bar visualizer. Reads engine.analyser each frame and draws
 * chunky bars on a tiny canvas — CSS scales it up with image-rendering:
 * pixelated, so it matches the pixel-art frame.
 */
export default function Visualizer({ engine, playing, theme }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;

    engine.ensureGraph();
    const analyser = engine.analyser;
    if (!analyser) return;

    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(analyser.frequencyBinCount);
    // Theme palette — read once per theme change
    const color = getComputedStyle(canvas).getPropertyValue('--color-secondary').trim() || '#8a6a7a';
    let raf;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(buf);
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = color;
      for (let i = 0; i < BARS; i++) {
        // Skip the very lowest bin (DC-ish rumble) and stride across the rest
        const v = buf[Math.min(buf.length - 1, 2 + i * 2)] / 255;
        const h = Math.max(1, Math.round(v * CANVAS_H));
        ctx.fillRect(i * (BAR_W + GAP), CANVAS_H - h, BAR_W, h);
      }
    };

    const drawIdle = () => {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = color;
      for (let i = 0; i < BARS; i++) {
        ctx.fillRect(i * (BAR_W + GAP), CANVAS_H - 1, BAR_W, 1);
      }
    };

    if (playing) draw();
    else drawIdle();

    return () => cancelAnimationFrame(raf);
  }, [engine, playing, theme]);

  return (
    <canvas
      ref={canvasRef}
      className="viz-canvas"
      width={CANVAS_W}
      height={CANVAS_H}
    />
  );
}
