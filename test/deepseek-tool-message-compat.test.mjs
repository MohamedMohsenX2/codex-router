import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  DeepseekToolMessageCompatTransform,
  deepseekToolMessageCompatTransform,
} from "../src/deepseek-tool-message-compat.mjs";

function block(event, newline = "\n") {
  return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function events(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith("data:")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5).trimStart()));
}

async function transformed(input, options = {}, chunkSize = 0) {
  const stream = new DeepseekToolMessageCompatTransform(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  if (chunkSize > 0) {
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(input);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

const blankMessage = {
  id: "msg_blank",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "", annotations: [] }],
};

const functionCall = {
  id: "call_list",
  type: "function_call",
  call_id: "call_list",
  name: "exec_command",
  arguments: "{}",
  status: "completed",
};

function phantomToolStream(newline = "\n") {
  return [
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }, newline),
    block({
      type: "response.content_part.added",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: "output_text", text: "", annotations: [] },
    }, newline),
    block({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 3,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }, newline),
    block({
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 1,
      sequence_number: 4,
      delta: "{}",
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 5,
      item: functionCall,
    }, newline),
    block({
      type: "response.output_text.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 6,
      text: "",
    }, newline),
    block({
      type: "response.content_part.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 7,
      part: { type: "reasoning_text", reasoning: "private reasoning" },
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 8,
      item: blankMessage,
    }, newline),
    block({
      type: "response.completed",
      sequence_number: 9,
      response: { id: "resp_1", status: "completed", output: [blankMessage, functionCall] },
    }, newline),
    `data: [DONE]${newline}${newline}`,
  ].join("");
}

test("removes DeepSeek's confirmed blank tool message and compacts indexes", async () => {
  const output = await transformed(phantomToolStream(), {}, 7);
  const seen = events(output);
  assert.equal(output.includes(blankMessage.id), false);
  assert.equal(output.includes("private reasoning"), false);
  assert.match(output, /data: \[DONE\]/);
  const toolEvents = seen.filter((event) => eventItem(event) === functionCall.id);
  assert.ok(toolEvents.length >= 3);
  assert.ok(toolEvents.every((event) => event.output_index === 0));
  assert.deepEqual(toolEvents.map((event) => event.sequence_number), [3, 4, 5]);
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

function eventItem(event) {
  return event.item_id ?? event.item?.id;
}

test("preserves CRLF framing while compacting the stream", async () => {
  const output = await transformed(phantomToolStream("\r\n"), {}, 11);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replaceAll("\r\n\r\n", "").includes("\n\n"), false);
  assert.ok(events(output).every((event) => {
    return !Number.isInteger(event.output_index) || event.output_index === 0;
  }));
});

test("fails open when the candidate later contains visible text", async () => {
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      delta: "I will inspect it.",
    }),
    block({ type: "response.output_item.added", output_index: 1, item: functionCall }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("leaves a blank response without a tool call byte-identical", async () => {
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("compacts separate reasoning and multiple later output items consistently", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [] };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const input = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({ type: "response.output_item.added", output_index: 1, item: reasoning }),
    block({ type: "response.output_item.done", output_index: 1, item: reasoning }),
    block({ type: "response.output_item.added", output_index: 2, item: functionCall }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: functionCall.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.added", output_index: 3, item: secondTool }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
    block({
      type: "response.completed",
      response: { output: [blankMessage, reasoning, functionCall, secondTool] },
    }),
  ].join("");
  const seen = events(await transformed(input));
  assert.deepEqual(
    seen.filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.id, event.output_index]),
    [[reasoning.id, 0], [functionCall.id, 1], [secondTool.id, 2]],
  );
  assert.equal(
    seen.find((event) => event.type === "response.function_call_arguments.done").output_index,
    1,
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [reasoning, functionCall, secondTool],
  );
});

test("byte budget expiry releases the entire stream unchanged", async () => {
  const input = phantomToolStream();
  assert.equal(
    await transformed(input, { maxCandidateBytes: 32, maxCandidateMs: 60_000 }),
    input,
  );
});

test("timer expiry releases pending bytes and subsequent chunks immediately", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = block({ type: "response.output_item.added", output_index: 1, item: functionCall });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(start);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, start);
  stream.write(tail);
  assert.equal(output, start + tail);
  stream.end();
  await once(stream, "end");
});

test("malformed and duplicate candidate lifecycles fail open", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const malformed = "event: response.output_item.added\ndata: {not-json}\n\n";
  assert.equal(await transformed(start + malformed), start + malformed);

  const second = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...blankMessage, id: "msg_two", status: "in_progress", content: [] },
  });
  assert.equal(await transformed(start + second), start + second);
});

test("conflicting item references and non-assistant messages fail open", async () => {
  const conflicting = block({
    type: "response.output_item.added",
    item_id: "msg_other",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = phantomToolStream().slice(phantomToolStream().indexOf("\n\n") + 2);
  assert.equal(await transformed(conflicting + tail), conflicting + tail);

  const nonAssistant = block({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      ...blankMessage,
      role: "user",
      status: "in_progress",
      content: [],
    },
  });
  assert.equal(await transformed(nonAssistant + tail), nonAssistant + tail);
});

test("refusal and unknown message parts are never classified as empty", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  for (const part of [
    { type: "refusal", refusal: "cannot comply" },
    { type: "audio", audio: "opaque" },
  ]) {
    const close = block({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...blankMessage, content: [part] },
    });
    assert.equal(await transformed(start + tool + close), start + tool + close);
  }
  const refusal = block({
    type: "response.refusal.delta",
    output_index: 0,
    item_id: blankMessage.id,
    delta: "cannot comply",
  });
  assert.equal(await transformed(start + tool + refusal), start + tool + refusal);
});

test("mismatched, duplicate, missing, and negative indexes fail open", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const toolAtTwo = block({
    type: "response.output_item.added",
    output_index: 2,
    item: { ...functionCall, status: "in_progress" },
  });
  const wrongDelta = block({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: functionCall.id,
    delta: "{}",
  });
  assert.equal(
    await transformed(start + toolAtTwo + wrongDelta),
    start + toolAtTwo + wrongDelta,
  );

  const duplicateIndex = block({
    type: "response.output_item.added",
    output_index: 2,
    item: { ...functionCall, id: "call_duplicate" },
  });
  assert.equal(
    await transformed(start + toolAtTwo + duplicateIndex),
    start + toolAtTwo + duplicateIndex,
  );

  const missingIndex = block({
    type: "response.function_call_arguments.done",
    item_id: functionCall.id,
    arguments: "{}",
  });
  assert.equal(
    await transformed(start + toolAtTwo + missingIndex),
    start + toolAtTwo + missingIndex,
  );

  const negative = block({
    type: "response.output_item.added",
    output_index: -1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(negative + toolAtTwo), negative + toolAtTwo);
});

test("tool proof requires a valid added lifecycle and matching terminal order", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const blankDone = block({
    type: "response.output_item.done",
    output_index: 0,
    item: blankMessage,
  });
  const toolDoneOnly = block({
    type: "response.output_item.done",
    output_index: 1,
    item: functionCall,
  });
  assert.equal(
    await transformed(start + toolDoneOnly + blankDone),
    start + toolDoneOnly + blankDone,
  );

  const terminalOnly = block({
    type: "response.completed",
    response: { output: [blankMessage, functionCall] },
  });
  assert.equal(
    await transformed(start + blankDone + terminalOnly),
    start + blankDone + terminalOnly,
  );

  const toolAdded = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  const wrongOrder = block({
    type: "response.completed",
    response: { output: [functionCall, blankMessage] },
  });
  assert.equal(
    await transformed(start + toolAdded + blankDone + wrongOrder),
    start + toolAdded + blankDone + wrongOrder,
  );
});

test("an oversized unterminated frame fails open without retaining the body", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = `data: ${"x".repeat(256)}`;
  assert.equal(
    await transformed(start + tail, { maxFrameBytes: 64, maxCandidateMs: 60_000 }),
    start + tail,
  );
});

test("delimiter-terminated frames and single-frame cap crossings are bounded", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const huge = block({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: functionCall.id,
    delta: "x".repeat(2_000),
  });
  assert.equal(
    await transformed(start + huge, { maxFrameBytes: 512, maxCandidateMs: 60_000 }),
    start + huge,
  );

  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress" },
  });
  assert.equal(
    await transformed(start + tool, {
      maxCandidateBytes: Buffer.byteLength(start) + 1,
      maxCandidateMs: 60_000,
    }),
    start + tool,
  );
});

test("timer expiry also releases an incomplete buffered frame", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const partial = "event: response.output_item.added\ndata: {\"type\":";
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(start + partial);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, start + partial);
  stream.end();
  await once(stream, "end");
});

test("destroying a pending stream clears its hold without later output", async () => {
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString("utf8"); });
  stream.write(start);
  stream.destroy();
  await once(stream, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, "");
});

test("post-suppression frames without shifted indexes remain byte-identical", async () => {
  const untouched = "event: response.done\ndata:  {\"type\":\"response.done\",\"response\":{\"id\":\"r1\"}}\n\n";
  const output = await transformed(phantomToolStream().replace("data: [DONE]\n\n", untouched));
  assert.ok(output.endsWith(untouched));
});

test("factory is provider-scoped, SSE-only, and returns fresh retry transforms", () => {
  const first = deepseekToolMessageCompatTransform("deepseek", "text/event-stream");
  const retry = deepseekToolMessageCompatTransform("deepseek", "text/event-stream");
  assert.ok(first instanceof DeepseekToolMessageCompatTransform);
  assert.ok(retry instanceof DeepseekToolMessageCompatTransform);
  assert.notEqual(first, retry);
  for (const provider of ["opencode-go", "commandcode", "qwen-plan", "zai-api"]) {
    assert.equal(deepseekToolMessageCompatTransform(provider, "text/event-stream"), undefined);
  }
  assert.equal(deepseekToolMessageCompatTransform("deepseek", "application/json"), undefined);
});
