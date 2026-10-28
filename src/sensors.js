'use strict';
/**
 * Emulated sensor nodes (perception layer) for tests, experiments and the demo.
 *
 * Each device follows a seeded random walk around a cold-chain set point
 * (2-8 degrees C band, humidity 55-70 %), so runs are reproducible. A device can be
 * given a temperature excursion: a stretch of readings above 8 degrees C, the kind of
 * event an interested party would want to erase from the log.
 */

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SensorFleet {
  constructor({ devices = 5, seed = 42, excursion = null } = {}) {
    this.rand = rng(seed);
    this.devices = Array.from({ length: devices }, (_, i) => ({
      dev: `sensor-${String(i + 1).padStart(2, '0')}`,
      t: 4 + this.rand() * 2,
      h: 60 + this.rand() * 5,
      n: 0,
    }));
    this.excursion = excursion; // { dev, from, to, peak } in per-device reading counts
    this.cursor = 0;
  }

  /** Next reading from one device (round-robin across the fleet). */
  next() {
    const d = this.devices[this.cursor];
    this.cursor = (this.cursor + 1) % this.devices.length;
    d.t += (this.rand() - 0.5) * 0.2 + (5 - d.t) * 0.05; // drift back toward 5 C
    d.h += (this.rand() - 0.5) * 0.6 + (62 - d.h) * 0.05;
    d.n += 1;
    let t = d.t;
    const ex = this.excursion;
    if (ex && d.dev === ex.dev && d.n >= ex.from && d.n <= ex.to) t = ex.peak + (this.rand() - 0.5) * 0.3;
    return { dev: d.dev, t, h: Math.min(100, Math.max(0, d.h)) };
  }

  take(n) {
    return Array.from({ length: n }, () => this.next());
  }
}

module.exports = { SensorFleet, rng };
