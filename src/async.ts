import { ProviderError } from "./errors.js";

/** Reject a provider call that exceeds its budget without cancelling its work. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderError(provider, `${provider} timed out`, { status: 504 }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
