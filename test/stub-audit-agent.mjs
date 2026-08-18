// Offline contract stand-in for the independent agent that drives Forma from outside the engine.
export function stubAuditAgent(plan, omitFirst = false) {
  const claims = omitFirst ? plan.claims.slice(1) : plan.claims
  const verdicts = ['holds', 'contradicted', 'unsupported']
  return { planHash: plan.planHash, results: claims.map((claim, i) => ({
    claimId: claim.id,
    verdict: verdicts[i % verdicts.length],
    reason: `Inspected ${claim.where[0].ref}.`,
    evidence: claim.where[0],
  })) }
}
