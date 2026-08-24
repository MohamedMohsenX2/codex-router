import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATE_MS = 1_000;
const MAX_FRAME_BYTES = 256 * 1024;

function parsedBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndexes = lines
    .map((line, index) => (line.startsWith("data:") ? index : -1))
    .filter((index) => index !== -1);
  const eventLines = lines.filter((line) => line.startsWith("event:"));
  if (dataLineIndexes.length !== 1 || eventLines.length > 1) return undefined;
  const [dataLineIndex] = dataLineIndexes;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    const event = JSON.parse(dataText);
    if (
      eventLines.length === 1 &&
      eventLines[0].slice(6).trim() !== event?.type
    ) {
      return undefined;
    }
    return { lines, dataLineIndex, newline, event };
  } catch {
    return undefined;
  }
}

function rewrittenBlock(parsed, event, separator) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return `${lines.join(parsed.newline)}${separator}`;
}

function itemId(value) {
  return typeof value === "string" && value ? value : undefined;
}

function eventItemReference(event) {
  const direct = itemId(event?.item_id);
  const nested = itemId(event?.item?.id);
  return {
    id: direct ?? nested,
    conflict: direct !== undefined && nested !== undefined && direct !== nested,
  };
}

function eventItemId(event) {
  return eventItemReference(event).id;
}

function isToolCall(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function candidateStart(item) {
  return (
    item?.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length === 0
  );
}

function finiteLimit(value, fallback, { minimum = 0, integer = false } = {}) {
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return integer ? Math.floor(value) : value;
}

function exactEmptyPart(part) {
  return (
    part != null &&
    typeof part === "object" &&
    ["output_text", "text"].includes(part.type) &&
    part.text === ""
  );
}

function exactEmptyMessage(item) {
  return (
    item?.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every(exactEmptyPart)
  );
}

function candidateLifecycle(event, id) {
  if (eventItemId(event) !== id) return false;
  return [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
  ].includes(event?.type);
}

function exactEmptyCandidateEvent(event) {
  switch (event?.type) {
    case "response.output_item.added":
      return candidateStart(event.item);
    case "response.content_part.added":
      return exactEmptyPart(event.part);
    case "response.output_text.delta":
      return event.delta === "";
    case "response.output_text.done":
      return event.text === "";
    case "response.content_part.done":
      return (
        exactEmptyPart(event.part) ||
        (event.part?.type === "reasoning_text" &&
          typeof event.part.reasoning === "string")
      );
    case "response.output_item.done":
      return exactEmptyMessage(event.item);
    default:
      return false;
  }
}

// LiteLLM's Chat-Completions -> Responses bridge can announce an empty
// assistant message before a DeepSeek tool call, then close that message after
// the call. Codex renders the empty lifecycle as a separate assistant turn.
//
// The tool cannot be renumbered until the preceding message is conclusively
// known to be empty: a legitimate mixed text/tool response has the same prefix.
// This transform therefore holds only that ambiguous interval under strict
// byte and time budgets. Every ambiguous, malformed, large, or slow shape fails
// open byte-for-byte and permanently disables the repair for that response.
export class DeepseekToolMessageCompatTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #candidate;
  #disabled = false;
  #suppressed;
  #maxCandidateBytes;
  #maxCandidateMs;
  #maxFrameBytes;
  #timer;

  constructor({
    maxCandidateBytes = MAX_CANDIDATE_BYTES,
    maxCandidateMs = MAX_CANDIDATE_MS,
    maxFrameBytes = MAX_FRAME_BYTES,
  } = {}) {
    super();
    this.#maxCandidateBytes = finiteLimit(
      maxCandidateBytes,
      MAX_CANDIDATE_BYTES,
      { integer: true },
    );
    this.#maxCandidateMs = finiteLimit(maxCandidateMs, MAX_CANDIDATE_MS);
    this.#maxFrameBytes = finiteLimit(maxFrameBytes, MAX_FRAME_BYTES, {
      minimum: 1,
      integer: true,
    });
  }

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    if (this.#disabled) {
      this.#pushBuffered();
      callback();
      return;
    }
    this.#emitCompleteBlocks();
    if (this.#disabled) {
      this.#pushBuffered();
    } else if (Buffer.byteLength(this.#buffer) > this.#maxFrameBytes) {
      this.#failOpen();
      this.#pushBuffered();
    }
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    this.#buffer += this.#decoder.end();
    if (this.#disabled) {
      this.#pushBuffered();
      callback();
      return;
    }
    this.#emitCompleteBlocks(true);
    if (this.#candidate) this.#failOpen();
    this.#pushBuffered();
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #emitCompleteBlocks(flush = false) {
    while (this.#buffer.length && !this.#disabled) {
      const crlf = this.#buffer.indexOf("\r\n\r\n");
      const lf = this.#buffer.indexOf("\n\n");
      let index = -1;
      let separator = "";
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        index = crlf;
        separator = "\r\n\r\n";
      } else if (lf !== -1) {
        index = lf;
        separator = "\n\n";
      }
      if (index === -1) {
        if (!flush) return;
        const block = this.#buffer;
        this.#buffer = "";
        if (Buffer.byteLength(block) > this.#maxFrameBytes) {
          this.#oversizedFrame(block);
          return;
        }
        this.#handleBlock(block, "");
        return;
      }
      const block = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + separator.length);
      if (Buffer.byteLength(block) + Buffer.byteLength(separator) > this.#maxFrameBytes) {
        this.#oversizedFrame(`${block}${separator}`);
        return;
      }
      this.#handleBlock(block, separator);
    }
  }

  #handleBlock(block, separator) {
    const frame = {
      original: `${block}${separator}`,
      parsed: parsedBlock(block),
      separator,
    };
    if (!frame.parsed) {
      if (this.#candidate) this.#failOpen(frame);
      else this.push(Buffer.from(frame.original));
      return;
    }
    const event = frame.parsed.event;
    if (this.#suppressed) {
      this.#pushCompacted(frame);
      return;
    }

    if (eventItemReference(event).conflict) {
      this.#failOpen(frame);
      return;
    }

    if (!this.#candidate) {
      if (
        event.type === "response.output_item.added" &&
        candidateStart(event.item) &&
        itemId(event.item?.id) &&
        Number.isInteger(event.output_index) &&
        event.output_index >= 0
      ) {
        this.#candidate = {
          id: event.item.id,
          outputIndex: event.output_index,
          frames: [],
          bytes: 0,
          sawTool: false,
          closed: false,
          itemIndexes: new Map([[event.item.id, event.output_index]]),
          indexItems: new Map([[event.output_index, event.item.id]]),
        };
        this.#startTimer();
        this.#hold(frame);
      } else {
        this.push(Buffer.from(frame.original));
      }
      return;
    }

    const candidate = this.#candidate;
    const attachedId = eventItemId(event);
    if (attachedId === candidate.id && !candidateLifecycle(event, candidate.id)) {
      this.#failOpen(frame);
      return;
    }
    if (candidateLifecycle(event, candidate.id)) {
      if (
        candidate.closed ||
        !Number.isInteger(event.output_index) ||
        event.output_index !== candidate.outputIndex ||
        !exactEmptyCandidateEvent(event)
      ) {
        this.#failOpen(frame);
        return;
      }
    } else if (event.type === "response.output_item.added") {
      const id = itemId(event.item?.id);
      const index = event.output_index;
      if (
        !id ||
        candidateStart(event.item) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index <= candidate.outputIndex ||
        candidate.itemIndexes.has(id) ||
        candidate.indexItems.has(index)
      ) {
        this.#failOpen(frame);
        return;
      }
      candidate.itemIndexes.set(id, index);
      candidate.indexItems.set(index, id);
      if (isToolCall(event.item)) candidate.sawTool = true;
    } else if (attachedId) {
      const expectedIndex = candidate.itemIndexes.get(attachedId);
      if (
        expectedIndex === undefined ||
        !Number.isInteger(event.output_index) ||
        event.output_index !== expectedIndex
      ) {
        this.#failOpen(frame);
        return;
      }
      if (isToolCall(event.item) && event.type !== "response.output_item.done") {
        this.#failOpen(frame);
        return;
      }
    }

    this.#hold(frame);
    if (!this.#candidate) return;

    if (
      event.type === "response.output_item.done" &&
      attachedId === candidate.id
    ) {
      candidate.closed = true;
      return;
    }

    if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
      if (this.#terminalMatchesCandidate(event.response.output, candidate)) {
        this.#suppress();
      } else this.#failOpen();
    }
  }

  #hold(frame) {
    if (!this.#candidate) return;
    const bytes = Buffer.byteLength(frame.original);
    if (this.#candidate.bytes + bytes > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#candidate.frames.push(frame);
    this.#candidate.bytes += bytes;
  }

  #terminalMatchesCandidate(output, candidate) {
    if (!candidate.closed || !candidate.sawTool) return false;
    if (candidate.outputIndex >= output.length) return false;
    if (!exactEmptyMessage(output[candidate.outputIndex])) return false;
    if (itemId(output[candidate.outputIndex]?.id) !== candidate.id) return false;
    const ids = new Set();
    for (let index = candidate.outputIndex; index < output.length; index += 1) {
      const id = itemId(output[index]?.id);
      if (!id || ids.has(id)) return false;
      ids.add(id);
      if (candidate.itemIndexes.get(id) !== index) return false;
    }
    return ids.size === candidate.itemIndexes.size;
  }

  #suppress() {
    const candidate = this.#candidate;
    if (!candidate) return;
    this.#candidate = undefined;
    this.#suppressed = { id: candidate.id, outputIndex: candidate.outputIndex };
    this.#clearTimer();
    for (const frame of candidate.frames) this.#pushCompacted(frame);
  }

  #failOpen(extraFrame) {
    const candidate = this.#candidate;
    this.#candidate = undefined;
    this.#clearTimer();
    if (candidate) {
      for (const frame of candidate.frames) this.push(Buffer.from(frame.original));
    }
    if (extraFrame) this.push(Buffer.from(extraFrame.original));
    this.#disabled = true;
  }

  #pushCompacted(frame) {
    const event = frame.parsed?.event;
    const suppressed = this.#suppressed;
    if (!event || !suppressed) {
      this.push(Buffer.from(frame.original));
      return;
    }
    if (candidateLifecycle(event, suppressed.id)) return;
    let next = event;
    let changed = false;
    if (
      Number.isInteger(event.output_index) &&
      event.output_index > suppressed.outputIndex
    ) {
      next = { ...next, output_index: event.output_index - 1 };
      changed = true;
    }
    if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
      const output = event.response.output.filter(
        (item) => itemId(item?.id) !== suppressed.id,
      );
      next = {
        ...next,
        response: {
          ...event.response,
          output,
        },
      };
      changed ||= output.length !== event.response.output.length;
    }
    this.push(
      Buffer.from(
        changed ? rewrittenBlock(frame.parsed, next, frame.separator) : frame.original,
      ),
    );
  }

  #oversizedFrame(original) {
    const frame = { original };
    if (this.#candidate) this.#failOpen(frame);
    else {
      this.push(Buffer.from(original));
      this.#disabled = true;
    }
  }

  #pushBuffered() {
    if (!this.#buffer) return;
    this.push(Buffer.from(this.#buffer));
    this.#buffer = "";
  }

  #startTimer() {
    if (this.#timer || !this.#candidate) return;
    this.#timer = setTimeout(() => {
      this.#failOpen();
      this.#pushBuffered();
    }, this.#maxCandidateMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export function deepseekToolMessageCompatTransform(providerId, contentType = "") {
  if (String(providerId) !== "deepseek") return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new DeepseekToolMessageCompatTransform();
}
