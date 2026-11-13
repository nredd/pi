# Test failure diagnostics

The footer reftable filesystem test reports bounded diagnostics only if a wait times out
([#69](https://github.com/nredd/pi/issues/69)): async git call count, cached fixture branch,
branch-change notifications, wait phase, elapsed time and maximum observation gap. Native
callback and polling-baseline timing remain unknown. The exact-count assertion and deadlines
are unchanged; a green run does not establish the historical timeout's cause.
