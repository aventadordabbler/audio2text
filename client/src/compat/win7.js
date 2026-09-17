// Chromium 108 has AbortSignal.timeout(), but not AbortSignal.any().
// Load this before either renderer entry point on the Win7 build only.
if (typeof AbortSignal.any !== "function") {
  AbortSignal.any = function any(signals) {
    const controller = new AbortController();
    const inputs = [...new Set(signals)];
    const aborted = inputs.find((signal) => signal.aborted);
    if (aborted) {
      controller.abort(aborted.reason);
      return controller.signal;
    }
    const cleanup = () => {
      for (const signal of inputs) signal.removeEventListener("abort", onAbort);
    };
    function onAbort(event) {
      cleanup();
      controller.abort(event.target.reason);
    }
    for (const signal of inputs) signal.addEventListener("abort", onAbort, { once: true });
    return controller.signal;
  };
}
