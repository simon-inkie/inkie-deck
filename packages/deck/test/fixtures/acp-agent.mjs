import { spawn } from "node:child_process";
import { closeSync, readSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const script = JSON.parse(process.argv[2]);
const sessionId = script.sessionId ?? "fixture/session-1";
let promptId;
let promptCount = 0;
const send = (value) => writeSync(1, `${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);

function update(value, target = sessionId) {
  send({ method: "session/update", params: { sessionId: target, update: value } });
}

function steps(actions = []) {
  for (const action of actions) {
    switch (action.kind) {
      case "update": update(action.update, action.sessionId); break;
      case "permission": send({ id: action.id, method: "session/request_permission", params: {
        sessionId: action.sessionId ?? sessionId,
        toolCall: action.toolCall ?? { toolCallId: "fixture-tool", title: "Tool" }, options: action.options,
      } }); break;
      case "result": send({ id: action.id ?? promptId, result: action.result }); break;
      case "error": send({ id: promptId, error: { code: -32603, message: "Fixture error" } }); break;
      case "line": writeSync(1, `${action.line}\n`); break;
      case "exit": process.exit(0);
      case "partial": writeSync(1, '{"jsonrpc":'); closeSync(1); break;
      case "environment": update({ sessionUpdate: "agent_message_chunk", content: {
        type: "text", text: JSON.stringify(action.keys.map((key) => Object.hasOwn(process.env, key))),
      } }); break;
      case "descendant": {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(child.pid) } });
        break;
      }
    }
  }
}

function handle(line) {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize": send({ id: message.id, result: {
      protocolVersion: script.protocolVersion ?? 1, agentCapabilities: script.capabilities ?? {},
    } }); break;
    case "session/new": send({ id: message.id, result: { sessionId } }); break;
    case "session/prompt":
      promptId = message.id;
      steps(script.prompts?.[promptCount++] ?? [{ kind: "result", result: { stopReason: "end_turn" } }]);
      break;
    case "session/cancel": steps(script.onCancel); break;
    case undefined: steps(script.onPermission?.[message.id]); break;
  }
}

const input = Buffer.alloc(4096);
const decoder = new StringDecoder();
let remaining = "";
for (let size = readSync(0, input); size; size = readSync(0, input)) {
  const lines = (remaining + decoder.write(input.subarray(0, size))).split("\n");
  remaining = lines.pop();
  for (const line of lines) handle(line);
}
