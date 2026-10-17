/** Strict SSE transport. An interrupted stream must never become a successful reply. */
export class StreamError extends Error {
  constructor(message: string, public partial = '') {
    super(message);
    this.name = 'StreamError';
  }
}

export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  onFinish?: (reason: string) => void,
  onReasoning?: (text: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '', reason = '';
  let dataLines: string[] = [];
  let ended = false;
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  };
  const dispatch = () => {
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (ended) return;
    if (!data) return;
    if (data === '[DONE]') { ended = true; return; }
    let event;
    try { event = JSON.parse(data); }
    catch { throw new StreamError('模型返回了无法解析的流式数据', full); }
    if (event.error) {
      throw new StreamError(typeof event.error === 'string' ? event.error : event.error.message || '模型服务发生错误', full);
    }
    const choice = event.choices?.[0];
    if (!choice) return; // usage-only events and heartbeats
    const delta = choice.delta?.content ?? choice.message?.content ?? '';
    if (typeof delta === 'string' && delta) { full += delta; onDelta?.(delta); }
    const think = choice.delta?.reasoning_content ?? choice.delta?.reasoning
      ?? choice.message?.reasoning_content ?? choice.message?.reasoning ?? '';
    if (typeof think === 'string' && think) onReasoning?.(think);
    if (choice.finish_reason) reason = choice.finish_reason;
  };
  const line = (raw: string) => {
    if (!raw.trim()) { dispatch(); return; }
    if (raw.startsWith('data:')) dataLines.push(raw.slice(5).replace(/^ /, ''));
  };
  try {
    checkAbort();
    while (!ended) {
      const { done, value } = await reader.read();
      checkAbort();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n/);
      buffer = lines.pop() ?? '';
      for (const item of lines) line(item);
      if (done) { if (buffer) line(buffer); dispatch(); break; }
    }
    if (!ended && !reason) throw new StreamError('连接提前结束，未收到模型完成信号；已保留收到的内容', full);
    onFinish?.(reason);
    return full;
  } catch (error) {
    checkAbort();
    if (error instanceof StreamError) throw error;
    throw new StreamError(`流式连接中断：${(error as Error).message}`, full);
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
