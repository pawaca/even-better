import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEntryParser, findCodexSessionFile, parseCodexEntry } from "../src/codex-transcript.js";
import { parseEntry, summarizeTool } from "../src/transcript.js";

// user prompt (string content)
test("user-prompt", () => assert.deepEqual(parseEntry(JSON.stringify({type:"user", message:{content:"帮我看下代码"}})),
  [{t:"prompt", text:"帮我看下代码"}]));
// harness wrapper skipped
test("skip-wrapper", () => assert.deepEqual(parseEntry(JSON.stringify({type:"user", message:{content:"<command-name>/goal</command-name>"}})), []));
// assistant text + usage (attached to the single event)
test("asst-text", () => assert.deepEqual(parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"回答内容"}], usage:{input_tokens:100, output_tokens:20}}})),
  [{t:"say", text:"回答内容", usage:{input:100, output:20}}]));
// tool use
test("tool-use", () => {
  const tu = parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"tool_use", id:"t1", name:"Bash", input:{command:"ls -la"}}]}}));
  assert.deepEqual([tu[0]?.t, (tu[0] as any)?.name, (tu[0] as any)?.input], ["tool", "Bash", {command:"ls -la"}]);
});
// tool result (array content)
test("tool-result", () => {
  const tr = parseEntry(JSON.stringify({type:"user", message:{content:[{type:"tool_result", tool_use_id:"t1", content:[{type:"text", text:"file1\nfile2"}]}]}}));
  assert.deepEqual([tr[0]?.t, (tr[0] as any)?.id, (tr[0] as any)?.output], ["toolResult", "t1", "file1\nfile2"]);
});
// usage attached to first event only (text + tool in one message → tool has no usage)
test("usage-once", () => {
  const multi = parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"hi"},{type:"tool_use",id:"t2",name:"Read",input:{}}], usage:{input_tokens:5, output_tokens:2}}}));
  assert.deepEqual([(multi[0] as any).usage, (multi[1] as any).usage], [{input:5,output:2}, undefined]);
});
// sidechain skipped
test("sidechain", () => assert.deepEqual(parseEntry(JSON.stringify({type:"assistant", isSidechain:true, message:{content:[{type:"text",text:"内部"}]}})), []));
// thinking skipped
test("thinking", () => assert.deepEqual(parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"thinking",thinking:"..."}]}})), []));
// summaries
test("sum-bash", () => assert.deepEqual(summarizeTool("Bash", {command:"grep -r foo ."}), "$ grep -r foo ."));
test("sum-codex-exec", () => assert.deepEqual(summarizeTool("exec_command", {cmd:"pnpm check"}), "$ pnpm check"));
test("sum-read", () => assert.deepEqual(summarizeTool("Read", {file_path:"/a/b.ts"}), "Read /a/b.ts"));
test("sum-write", () => assert.deepEqual(summarizeTool("Write", {file_path:"/a/b.txt"}), "Write /a/b.txt"));
test("sum-plan", () => assert.deepEqual(summarizeTool("update_plan", {plan:[]}), "Update plan"));
test("sum-web-search-url", () => assert.deepEqual(summarizeTool("WebSearch", {type:"open_page", url:"https://example.com"}), "Open https://example.com"));
test("sum-tool-search", () => assert.deepEqual(summarizeTool("tool_search", {query:"github issue"}), "Search tools github issue"));
test("sum-unknown", () => assert.deepEqual(summarizeTool("MyTool", {q:"hello"}), "MyTool: hello"));

// Codex interactive rollout transcript
test("codex-home-session-file", () => {
  const oldCodexHome = process.env.CODEX_HOME;
  const tempCodexHome = mkdtempSync(join(tmpdir(), "even-better-codex-home-"));
  try {
    const sessionId = "custom-home-session";
    const sessionDir = join(tempCodexHome, "sessions", "2026", "07", "07");
    const sessionFile = join(sessionDir, `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, "");
    process.env.CODEX_HOME = tempCodexHome;
    assert.deepEqual(findCodexSessionFile(sessionId), sessionFile);
  } finally {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    rmSync(tempCodexHome, { recursive: true, force: true });
  }
});
test("codex-user", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "response_item",
  payload: {type:"message", role:"user", content:[{type:"input_text", text:"实现 codex 支持"}]},
})), [{t:"prompt", text:"实现 codex 支持"}]));
test("codex-assistant", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "response_item",
  payload: {type:"message", role:"assistant", content:[{type:"output_text", text:"我会先读代码。"}]},
})), [{t:"say", text:"我会先读代码。"}]));
test("codex-event-user", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "event_msg",
  payload: {type:"user_message", message:"从 event_msg 来的用户消息"},
})), [{t:"prompt", text:"从 event_msg 来的用户消息"}]));
test("codex-event-agent", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "event_msg",
  payload: {type:"agent_message", message:"从 event_msg 来的助手消息"},
})), [{t:"say", text:"从 event_msg 来的助手消息"}]));
const codexMessageDedupe = new CodexEntryParser();
const responseMessage = JSON.stringify({
  timestamp: "2026-07-06T00:00:00.000Z",
  type: "response_item",
  payload: {type:"message", role:"assistant", content:[{type:"output_text", text:"同一条助手消息"}]},
});
const eventMessage = JSON.stringify({
  timestamp: "2026-07-06T00:00:00.010Z",
  type: "event_msg",
  payload: {type:"agent_message", message:"同一条助手消息"},
});
test("codex-event-dedup-response-first", () => assert.deepEqual([codexMessageDedupe.parse(responseMessage), codexMessageDedupe.parse(eventMessage)],
  [[{t:"say", text:"同一条助手消息"}], []]));
const codexMessageDedupeReverse = new CodexEntryParser();
test("codex-event-dedup-event-first", () => assert.deepEqual([codexMessageDedupeReverse.parse(eventMessage), codexMessageDedupeReverse.parse(responseMessage)],
  [[{t:"say", text:"同一条助手消息"}], []]));
const codexTaskCompleteDedupe = new CodexEntryParser();
const taskComplete = JSON.stringify({
  timestamp: "2026-07-06T00:00:00.020Z",
  type: "event_msg",
  payload: {type:"task_complete", last_agent_message:"同一条助手消息"},
});
test("codex-task-complete-dedup", () => assert.deepEqual([codexTaskCompleteDedupe.parse(responseMessage), codexTaskCompleteDedupe.parse(taskComplete)],
  [[{t:"say", text:"同一条助手消息"}], []]));
test("codex-task-complete-fallback", () => assert.deepEqual(new CodexEntryParser().parse(taskComplete), [{t:"say", text:"同一条助手消息"}]));
test("codex-tool", () => {
  const codexTool = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"function_call", call_id:"call_1", name:"exec_command", arguments:JSON.stringify({cmd:"ls", workdir:"/tmp"})},
  }));
  assert.deepEqual([codexTool[0]?.t, (codexTool[0] as any)?.id, (codexTool[0] as any)?.name, (codexTool[0] as any)?.input],
    ["tool", "call_1", "exec_command", {cmd:"ls", workdir:"/tmp"}]);
});
test("codex-tool-result", () => {
  const codexResult = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"function_call_output", call_id:"call_1", output:"file1\nfile2"},
  }));
  assert.deepEqual([codexResult[0]?.t, (codexResult[0] as any)?.id, (codexResult[0] as any)?.output],
    ["toolResult", "call_1", "file1\nfile2"]);
});
test("codex-custom-tool", () => {
  const codexCustomTool = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"custom_tool_call", call_id:"call_patch", name:"apply_patch", input:"*** Begin Patch\n*** End Patch\n"},
  }));
  assert.deepEqual([codexCustomTool[0]?.t, (codexCustomTool[0] as any)?.id, (codexCustomTool[0] as any)?.name, (codexCustomTool[0] as any)?.input],
    ["tool", "call_patch", "apply_patch", {input:"*** Begin Patch\n*** End Patch\n"}]);
});
test("codex-custom-tool-result", () => {
  const codexCustomResult = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"custom_tool_call_output", call_id:"call_patch", output:"Success"},
  }));
  assert.deepEqual([codexCustomResult[0]?.t, (codexCustomResult[0] as any)?.id, (codexCustomResult[0] as any)?.output],
    ["toolResult", "call_patch", "Success"]);
});
test("codex-web-search", () => {
  const codexWebSearch = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"web_search_call", id:"ws_1", status:"completed", action:{type:"search", query:"tailscale funnel", queries:["tailscale funnel"]}},
  }));
  assert.deepEqual(codexWebSearch, [
    {t:"tool", id:"ws_1", name:"WebSearch", input:{type:"search", query:"tailscale funnel", queries:["tailscale funnel"]}},
    {t:"toolResult", id:"ws_1", output:"Searched tailscale funnel", ok:true},
  ]);
});
const codexWebSearchDedupe = new CodexEntryParser();
const webSearchEnd = JSON.stringify({
  type: "event_msg",
  payload: {type:"web_search_end", call_id:"ws_2", action:{type:"open_page", url:"https://tailscale.com/kb/1223/funnel"}},
});
const webSearchCall = JSON.stringify({
  type: "response_item",
  payload: {type:"web_search_call", id:"ws_2", status:"completed", action:{type:"open_page", url:"https://tailscale.com/kb/1223/funnel"}},
});
test("codex-web-search-end-dedup", () => assert.deepEqual([codexWebSearchDedupe.parse(webSearchEnd), codexWebSearchDedupe.parse(webSearchCall)], [
  [
    {t:"tool", id:"ws_2", name:"WebSearch", input:{type:"open_page", url:"https://tailscale.com/kb/1223/funnel"}},
    {t:"toolResult", id:"ws_2", output:"Opened https://tailscale.com/kb/1223/funnel", ok:true},
  ],
  [],
]));
const codexWebSearchProgress = new CodexEntryParser();
const webSearchProgressStart = JSON.stringify({
  type: "response_item",
  payload: {type:"web_search_call", id:"ws_3", status:"searching", action:{type:"search", query:"codex rollout"}},
});
const webSearchProgressDone = JSON.stringify({
  type: "response_item",
  payload: {type:"web_search_call", id:"ws_3", status:"completed", action:{type:"search", query:"codex rollout"}},
});
test("codex-web-search-progress", () => assert.deepEqual([
  codexWebSearchProgress.parse(webSearchProgressStart),
  codexWebSearchProgress.parse(webSearchProgressDone),
], [
  [{t:"tool", id:"ws_3", name:"WebSearch", input:{type:"search", query:"codex rollout"}}],
  [{t:"toolResult", id:"ws_3", output:"Searched codex rollout", ok:true}],
]));
test("codex-tool-search-call", () => {
  const codexToolSearch = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"tool_search_call", call_id:"call_tools", status:"completed", arguments:{query:"github pull request", limit:8}},
  }));
  assert.deepEqual(codexToolSearch, [
    {t:"tool", id:"call_tools", name:"tool_search", input:{query:"github pull request", limit:8}},
  ]);
});
const codexToolSearchStartDedupe = new CodexEntryParser();
const codexToolSearchPendingCall = JSON.stringify({
  type: "response_item",
  payload: {type:"tool_search_call", call_id:"call_tools_dedupe", status:"in_progress", arguments:{query:"github pull request"}},
});
const codexToolSearchCompletedCall = JSON.stringify({
  type: "response_item",
  payload: {type:"tool_search_call", call_id:"call_tools_dedupe", status:"completed", arguments:{query:"github pull request"}},
});
test("codex-tool-search-start-dedupe", () => assert.deepEqual([
  codexToolSearchStartDedupe.parse(codexToolSearchPendingCall),
  codexToolSearchStartDedupe.parse(codexToolSearchCompletedCall),
], [
  [{t:"tool", id:"call_tools_dedupe", name:"tool_search", input:{query:"github pull request"}}],
  [],
]));
test("codex-tool-search-output", () => {
  const codexToolSearchOutput = parseCodexEntry(JSON.stringify({
    type: "response_item",
    payload: {type:"tool_search_output", call_id:"call_tools", status:"completed", tools:[
      {namespace:"github", name:"github.pr"},
      {namespace:"linear", name:"linear.issue"},
    ]},
  }));
  assert.deepEqual(codexToolSearchOutput, [
    {t:"toolResult", id:"call_tools", output:"Found 2 tools: github, linear", ok:true},
  ]);
});
const codexToolSearchProgress = new CodexEntryParser();
const codexToolSearchPendingOutput = JSON.stringify({
  type: "response_item",
  payload: {type:"tool_search_output", call_id:"call_tools_progress", status:"in_progress", tools:[]},
});
const codexToolSearchCompletedOutput = JSON.stringify({
  type: "response_item",
  payload: {type:"tool_search_output", call_id:"call_tools_progress", status:"completed", tools:[
    {namespace:"github", name:"github.pr"},
  ]},
});
test("codex-tool-search-output-progress", () => assert.deepEqual([
  codexToolSearchProgress.parse(codexToolSearchPendingOutput),
  codexToolSearchProgress.parse(codexToolSearchCompletedOutput),
], [
  [],
  [{t:"toolResult", id:"call_tools_progress", output:"Found 1 tools: github", ok:true}],
]));
test("codex-turn-aborted", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "event_msg",
  payload: {type:"turn_aborted", reason:"interrupted"},
})), [{t:"turnEnd", success:false, text:"Interrupted by user"}]));
test("codex-thread-rolled-back", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "event_msg",
  payload: {type:"thread_rolled_back", num_turns:2},
})), [{t:"turnEnd", success:false, text:"Rolled back 2 turns"}]));
test("codex-usage", () => assert.deepEqual(parseCodexEntry(JSON.stringify({
  type: "event_msg",
  payload: {type:"token_count", info:{last_token_usage:{input_tokens:10, output_tokens:3}}},
})), [{t:"usage", usage:{input:10, output:3}}]));
const codexParser = new CodexEntryParser();
const tokenCount = (input: number, output: number, lastInput = input, lastOutput = output) => JSON.stringify({
  type: "event_msg",
  payload: {type:"token_count", info:{
    total_token_usage:{input_tokens:input, output_tokens:output},
    last_token_usage:{input_tokens:lastInput, output_tokens:lastOutput},
  }},
});
test("codex-usage-total-first", () => assert.deepEqual(codexParser.parse(tokenCount(10, 3)), [{t:"usage", usage:{input:10, output:3}}]));
test("codex-usage-total-dupe", () => assert.deepEqual(codexParser.parse(tokenCount(10, 3)), []));
test("codex-usage-total-delta", () => assert.deepEqual(codexParser.parse(tokenCount(15, 4, 99, 99)), [{t:"usage", usage:{input:5, output:1}}]));
