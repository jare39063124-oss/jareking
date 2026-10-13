/**
 * HTTP 底座（T4.1）：超时控制 + 指数退避重试。
 *
 * 重试范围：429 / 5xx / 网络错误（TypeError）；4xx 客户端错误不重试。
 * 退避：300ms × 2^n + 随机抖动。
 */

export interface RetryOptions {
  timeoutMs?: number; // 默认 60s
  maxRetries?: number; // 默认 2（总尝试 = maxRetries + 1）
  signal?: AbortSignal;
}

/** 组合外部 signal 与超时 signal */
function combinedSignal(options: RetryOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** 带重试的 fetch（用于非流式与流式的建连阶段；流式读取中途失败不自动重试） */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  let lastError: unknown = new Error('未发起请求');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: combinedSignal(options),
      });
      if (res.ok || !isRetryableStatus(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      // 调用方主动取消：不重试直接抛
      if (options.signal?.aborted) throw err;
      lastError = err;
    }
    if (attempt < maxRetries) {
      await sleep(300 * 2 ** attempt + Math.random() * 150);
    }
  }
  throw lastError;
}
