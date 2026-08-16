import { SHED_ABOVE } from "./types.ts";
import type { AdmissionRequest, Priority } from "./types.ts";

/**
 * Shared priority and fairness logic, so the limiter and throttler shed consistently rather
 * than each inventing their own rules.
 */

/**
 * Should work at this priority be shed, given how much pressure the policy is under?
 *
 * `pressure` is 0 (idle) to 1 (about to refuse everything). Each policy computes its own — the
 * limiter from queue depth against its limit, the throttler from its rejection rate — so the
 * meaning is local but the ladder is shared.
 *
 * Progressive by construction: as pressure rises, `bulk` goes first, then `bestEffort`, then
 * `degraded`. `critical` is only shed at full pressure, where the policy would have refused the
 * call regardless of what it was labelled.
 */
export const shouldShed = (pressure: number, priority: Priority = "critical"): boolean =>
  pressure >= 1 ? true : pressure > SHED_ABOVE[priority];

export const priorityOf = (request?: AdmissionRequest): Priority => request?.priority ?? "critical";

/**
 * Relative tenant fairness.
 *
 * Tracks recent admissions per tenant so that, when something must be shed, the tenant furthest
 * above its fair share goes first. Fair share is simply `admitted / activeTenants` — no
 * configuration, because a fixed per-tenant quota needs a number nobody knows, goes stale, and
 * wastes capacity whenever tenants are idle.
 *
 * Deliberately approximate. This decides *who* to shed once a policy has already decided that
 * something must be; it is not an accounting system.
 */
export class FairShare {
  private readonly counts = new Map<string, number>();
  private total = 0;
  private readonly halfLife: number;
  private sinceDecay = 0;

  /** `halfLife` is in admissions, not milliseconds — no clock needed, and it decays with use. */
  constructor(halfLife = 1_000) {
    this.halfLife = Math.max(1, halfLife);
  }

  record(tenant: string): void {
    this.counts.set(tenant, (this.counts.get(tenant) ?? 0) + 1);
    this.total++;
    if (++this.sinceDecay >= this.halfLife) this.decay();
  }

  /**
   * Halve every count, so a tenant that was heavy an hour ago is not punished forever. Tenants
   * that decay to nothing are dropped, which also bounds the map.
   */
  private decay(): void {
    this.sinceDecay = 0;
    this.total = 0;
    for (const [tenant, count] of this.counts) {
      const next = count / 2;
      if (next < 1) this.counts.delete(tenant);
      else {
        this.counts.set(tenant, next);
        this.total += next;
      }
    }
  }

  /** How far above its fair share this tenant is. 1 means exactly fair; 3 means 3x its share. */
  overuse(tenant: string): number {
    const tenants = this.counts.size;
    if (tenants <= 1 || this.total === 0) return 1;
    const fair = this.total / tenants;
    return (this.counts.get(tenant) ?? 0) / Math.max(1, fair);
  }

  /**
   * Under pressure, shed the tenants furthest above their share first.
   *
   * The threshold relaxes as pressure rises: at low pressure only egregious hogs are shed, and
   * by full pressure everyone is equally sheddable. Without that, mild pressure would punish a
   * moderately-above-average tenant as harshly as a runaway one.
   */
  shouldShed(tenant: string | undefined, pressure: number): boolean {
    if (tenant === undefined || pressure <= 0) return false;
    const tolerated = 1 + (1 - Math.min(1, pressure)) * 4;
    return this.overuse(tenant) > tolerated;
  }

  get tenantCount(): number {
    return this.counts.size;
  }

  reset(): void {
    this.counts.clear();
    this.total = 0;
    this.sinceDecay = 0;
  }
}
