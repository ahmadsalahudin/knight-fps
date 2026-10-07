/* sfx.js — window.Sfx (extracted verbatim; WebAudio oscillator/noise beeps) */
(function() {
  let audioContext;
  function getAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function playSound(f, duration = 0.1) {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = f.type || 'square';
    osc.frequency.setValueAtTime(f.freq || 440, ctx.currentTime);
    if (f.pitchBend) {
      osc.frequency.linearRampToValueAtTime(f.freq * f.pitchBend, ctx.currentTime + 0.05);
    }
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  function playNoise(duration = 0.2) {
    const ctx = getAudioContext();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1600;
    source.connect(filter);
    filter.connect(ctx.destination);
    source.start(0);
    source.stop(ctx.currentTime + duration);
  }

  const Sfx = {
    _initialized: false,
    init: function() {
      // Lazy initialization on first user gesture
    },
    shoot: function() {
      playSound({ type: 'square', freq: 110, pitchBend: 0.5 });
      playNoise(0.05);
    },
    reload: function() {
      playSound({ type: 'square', freq: 220, pitchBend: 0.8 });
      playSound({ type: 'square', freq: 330, pitchBend: 0.9 });
    },
    swing: function() {
      playNoise(0.3);
    },
    hurt: function() {
      playSound({ type: 'sawtooth', freq: 660 });
    },
    hit: function() {
      playSound({ type: 'square', freq: 200, pitchBend: 2.0 });
    },
    death: function() {
      playSound({ type: 'sawtooth', freq: 110, pitchBend: 0.5 });
      playSound({ type: 'sawtooth', freq: 100, pitchBend: 0.5 });
    },
    roar: function() {
      playSound({ type: 'sawtooth', freq: 88, pitchBend: 0.5 });
      playSound({ type: 'sawtooth', freq: 77, pitchBend: 0.5 });
    }
  };

  window.Sfx = Sfx;
})();
