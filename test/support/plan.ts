// The branch tip a `DispatchPlan` carries (T73), for every suite whose subject
// is not which commit that is. `planFor` requires one on all three arms —
// there is nothing to invent for a fork commit — so the value is spelled once
// here rather than sixteen times, and a suite that *is* about the tip (the
// dispatch's own, which reads it off git) uses its own.
export const PLAN_TIP = "7777777777777777777777777777777777777777";
