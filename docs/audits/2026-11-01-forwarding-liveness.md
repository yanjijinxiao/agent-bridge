# Forwarding liveness after an unknown handoff

The live incident had one retained unknown submission followed by three messages still in `received`, with zero dispatch attempts. `ForwardingInbox.deliver` treated every earlier automatic record as an active handoff, including terminal routing failures and unknown receipts. Their durable retention therefore locked the conversation across Gateway restarts while the UI repeatedly said it was waiting for a prior handoff.

Source ordering now waits only for an actual in-process dispatch or an earlier pending, known-unsubmitted input. A held or unknown record with no active dispatch remains available for inspection and is never automatically replayed. It does not prevent an independent later message from reaching the same still-current binding. Native acceptance and finished execution remain separate; the exact source, target and role guards are unchanged.

Regression cases cover unknown outcomes with and without restart, a live handoff that later becomes unknown, a retained known-unsubmitted held input, no replay of the original uncertain source, and the existing ordered retry of pending known-unsubmitted input. This is a transport fix, not an authorization to assume acceptance or delete an unknown receipt.

Deploy the narrow patch on the currently live baseline. The separate native-service unification is not a prerequisite for this repair and must not be represented as deployed by this hotfix.
