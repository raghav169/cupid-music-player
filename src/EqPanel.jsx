import { EQ_BANDS, EQ_PRESETS } from './audio/AudioEngine.js';

/**
 * 10-band EQ: preset row + vertical gain sliders (-12 to +12 dB).
 * Parent owns the gains array and persistence.
 */
export default function EqPanel({ gains, onChange }) {
  return (
    <div className="eq-panel">
      <div className="settings-theme-row">
        {Object.keys(EQ_PRESETS).map((name) => (
          <button
            key={name}
            className="settings-theme-btn"
            onClick={() => onChange([...EQ_PRESETS[name]])}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="eq-bands">
        {EQ_BANDS.map((freq, i) => (
          <input
            key={freq}
            type="range"
            className="eq-slider"
            min={-12}
            max={12}
            step={1}
            value={gains[i] ?? 0}
            title={freq >= 1000 ? `${freq / 1000}k` : `${freq}`}
            onChange={(e) => {
              const next = [...gains];
              next[i] = Number(e.target.value);
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
