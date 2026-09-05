/** Shared primitives for official HTTP/API providers. */
export function requestContext(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    signal: controller.signal,
    dispose() { clearTimeout(timer); },
  };
}
