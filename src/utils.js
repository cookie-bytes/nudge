export async function fetchWithTimeout(url, options = {}) {
  const { timeout = 3000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
