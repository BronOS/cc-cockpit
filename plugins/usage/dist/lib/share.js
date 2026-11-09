'use strict'
// One scanner for all windows. Every project window runs its own plugin host, so without this N
// windows would each read the same transcripts. ctx.appStorage (main-owned, app-wide, one call at a
// time) carries the coordination; there are no locks, so the one atomic primitive, `increment`, picks
// the winner:
//
//   lease              { owner, gen, until }  the scanning host and how long it holds the role
//   claim:<gen>:<slot> counter               the first host whose increment returns 1 takes the lease
//   agg                the published aggregate (store.fittedSnapshot), under 1 MiB less 8 KiB
//   aggVersion         counter bumped after each publish; followers read `agg` only when it moved
//   poke               counter: a follower whose session ended a turn asks the leader for a pass
//
// The leader renews its lease while it runs; a window that closes releases it, one that dies just
// lets it run out (LEASE_MS). A claim key carries the time slot too, so a host that won a claim and
// died before writing the lease blocks that generation for one slot only. Two leaders can overlap for
// a moment (one renews late while another claims): both then scan and publish the same data, which
// is wasted work, never wrong data; the next tick sorts it out.
const LEASE_MS = 30 * 1000

class Share {
  constructor(appStorage, { hostId, now = Date.now, leaseMs = LEASE_MS, log = null }) {
    this.kv = appStorage
    this.hostId = hostId
    this.now = now
    this.leaseMs = leaseMs
    this.log = log
    this.leader = false
    this.version = undefined
    this.pokes = undefined
  }

  /** Renew, keep or try to take the lease. Resolves true while this host is the leader. */
  async tick() {
    const t = this.now()
    const lease = await this.kv.get('lease')
    const valid = lease && typeof lease === 'object' && typeof lease.until === 'number' && lease.until > t
    if (valid && lease.owner === this.hostId) {
      if (lease.until - t < this.leaseMs / 2) await this.kv.set('lease', { owner: this.hostId, gen: lease.gen, until: t + this.leaseMs })
      return (this.leader = true)
    }
    if (valid) return (this.leader = false)
    const gen = (lease && Number.isInteger(lease.gen) ? lease.gen : 0) + 1
    const slot = Math.floor(t / this.leaseMs)
    const claim = `claim:${gen}:${slot}`
    const n = await this.kv.increment(claim)
    if (n !== 1) return (this.leader = false)
    await this.kv.set('lease', { owner: this.hostId, gen, until: t + this.leaseMs })
    // Old claim counters, ours from before and any a dead winner left: only the new one matters.
    try {
      for (const k of await this.kv.keys()) if (k.startsWith('claim:') && k !== claim) await this.kv.delete(k)
    } catch (e) {
      if (this.log) this.log.warn(`claim cleanup: ${e.message}`)
    }
    return (this.leader = true)
  }

  /** Give the lease up (a closing window), so another window takes over at its next tick. */
  async release() {
    if (!this.leader) return
    this.leader = false
    const lease = await this.kv.get('lease')
    if (lease && lease.owner === this.hostId) await this.kv.set('lease', { owner: null, gen: lease.gen, until: 0 })
  }

  async publish(agg) {
    await this.kv.set('agg', agg)
    this.version = await this.kv.increment('aggVersion')
  }

  /** The published aggregate when it changed since this host last read (or published) it, else null. */
  async readIfNew() {
    const v = await this.kv.get('aggVersion')
    if (v === undefined || v === null || v === this.version) return null
    const agg = await this.kv.get('agg')
    this.version = v
    return agg && typeof agg === 'object' ? agg : null
  }

  /** The published aggregate, whatever its version (a host's first look). */
  async read() {
    const [v, agg] = [await this.kv.get('aggVersion'), await this.kv.get('agg')]
    this.version = v
    return agg && typeof agg === 'object' ? agg : null
  }

  async poke() {
    await this.kv.increment('poke')
  }

  /** Leader side: whether a follower poked since the last call (the first call only learns the count). */
  async poked() {
    const raw = await this.kv.get('poke')
    const n = typeof raw === 'number' ? raw : 0
    const first = this.pokes === undefined
    const moved = n !== this.pokes
    this.pokes = n
    return !first && moved
  }
}

module.exports = { Share, LEASE_MS }
