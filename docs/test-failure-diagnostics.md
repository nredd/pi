# Test failure diagnostics

The footer reftable filesystem test reports bounded diagnostics only if a wait times out
([#69](https://github.com/nredd/pi/issues/69)): async git call count, cached fixture branch,
branch-change notifications, wait phase, elapsed time and maximum observation gap. Native
callback and polling-baseline timing remain unknown. The exact-count assertion and deadlines
are unchanged; a green run does not establish the historical timeout's cause.

The reftable polling fallback captures its metadata baseline synchronously during watcher
setup, then samples asynchronously every 250ms. This preserves a change made before the
first asynchronous stat completes, even if native watcher startup misses that change.
Only one sample is in flight, and results from disposed or retargeted watchers are ignored.
This startup failure mode is reproducible on real filesystem fixtures under delayed stat
sampling; it does not establish the unrecorded native/poll timing of earlier failures.

Watcher setup already discovers git paths and reads metadata synchronously. The fallback adds
one synchronous `stat` of `tables.list` to retain a baseline before the constructor or `setCwd`
returns. This can block on a slow filesystem; subsequent samples remain asynchronous and do
not overlap. Sampling errors close the watchers and use the existing five-second retry path.

A refresh that starts (from the native watcher or the poll) also adopts the current `tables.list`
metadata as the poll baseline, so one mutation spawns one git process instead of one per observer.

Instrumenting the debounce test in `footer-data-provider.test.ts` over 40 runs showed the extra
refresh that once forced a `<=2` ceiling came from late *native* events (`headWatcher` on the
fixture's `HEAD` write, `reftableWatcher`) delivered during the fake-timer window. The stat poll
never fired. The test now closes the real watchers (listeners stay attached, so `emit` still drives
them) and asserts exactly one refresh; a trailing refresh from a coalesced burst fails it.

`footer-data-provider.startup.test.ts` queues real crypto work on the libuv pool before
constructing and immediately mutating 32 real filesystem fixtures. It needs neither `mkfifo`
nor a platform skip; only git replies are mocked. The burst amplifies native startup loss,
which remains OS-scheduling-dependent. It failed locally on the original implementation and
passes with the retained baseline. Separate controlled polling tests cover errors, cleanup,
non-overlap and late callbacks after disposal or a working-directory change. Neither test
changes the original footer test's deadlines, exact-count assertion or failure diagnostics.

The startup trace launch fixture creates its trace file with `openSync`, which applies the caller umask. `startup-trace.test.ts` therefore sets the requested mode with `fchmodSync` and checks it with `fstatSync` before launching. Without that, the nonprivate-file case ([#77](https://github.com/nredd/pi/issues/77)) became a private `0600` file under `umask 0077`, e.g. in `./test.sh`, and the producer correctly traced it. Production behavior is unchanged.
