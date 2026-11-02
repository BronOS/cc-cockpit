// Who owns each `ccc <name>` plugin command (plan B Task 4): the one ordering rule the installer
// applies at install, link, update, start and every re-validation, kept in one pure function so
// those checks cannot drift apart.
//
// The rule: walk the plugins in clash order (bundled first, then the index's insertion order; the
// installer builds that order). A plugin whose names are all free claims every one of them; a
// plugin with ANY name already claimed loses and claims none, so a loser never blocks a later
// plugin with a name only the loser had.

/** One plugin's `contributes.cli` names. */
export interface CliClaim {
  id: string
  names: readonly string[]
}

/** Why a plugin lost: the first of its names an earlier plugin owns, and that plugin's id. */
export interface CliLoss {
  name: string
  owner: string
}

export interface CliOwnership {
  /** Command name -> owning plugin id. */
  owners: ReadonlyMap<string, string>
  /** Plugin id -> why it lost; a plugin not in here keeps all of its names. */
  lost: ReadonlyMap<string, CliLoss>
}

/** Settle `claims`, given in clash order (earlier wins). */
export function settleCliNames(claims: Iterable<CliClaim>): CliOwnership {
  const owners = new Map<string, string>()
  const lost = new Map<string, CliLoss>()
  for (const claim of claims) {
    const taken = claim.names.find((n) => owners.has(n))
    if (taken !== undefined) {
      lost.set(claim.id, { name: taken, owner: owners.get(taken) as string })
      continue
    }
    for (const n of claim.names) owners.set(n, claim.id)
  }
  return { owners, lost }
}

/** The reason a losing plugin is disabled with (and an install or link is refused with). */
export function cliLossReason(loss: CliLoss): string {
  return `cli command "${loss.name}" is already provided by plugin ${loss.owner}`
}
