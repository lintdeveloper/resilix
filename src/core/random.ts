/**
 * Injected randomness.
 *
 * resilix went three versions without any, deliberately: module-scope randomness breaks
 * Cloudflare Workers, and determinism is what keeps the test suite free of flakes. The v0.3
 * limiter even sheds on a deterministic ladder rather than a coin flip.
 *
 * v0.4 cannot do that. Full jitter and probabilistic throttling are irreducibly random, because
 * their entire purpose is to DECORRELATE clients. A deterministic backoff means every client in
 * a fleet retries at the same instant — precisely the thundering herd the jitter exists to
 * prevent. Determinism is not the conservative choice here; it is the wrong answer.
 *
 * So randomness is injected exactly as `Clock` is: real at runtime, seeded in tests.
 */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
}

/**
 * Note `Math.random` is referenced inside the function, never at module scope. Workers rejects
 * random-value generation in global scope, which is the same constraint that makes resilix safe
 * to `import` at the top level of a worker.
 */
export const systemRandom: Random = {
  next: () => Math.random(),
};

/**
 * Seeded, reproducible randomness for tests.
 *
 * A 32-bit xorshift: good enough to decorrelate, small enough to read, and identical across
 * every runtime — which matters because the same tests run on Node, Bun and Deno.
 */
export class FakeRandom implements Random {
  private state: number;

  constructor(seed = 1) {
    // A zero state is a fixed point for xorshift, so it must never be allowed.
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x1_0000_0000;
  }
}

/** A Random that always returns the same value. Useful for pinning one branch of a decision. */
export const constantRandom = (value: number): Random => ({ next: () => value });
