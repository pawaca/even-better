import { parseEntry, summarizeTool } from "../src/transcript.js";

const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)?.slice(0, 120)}`);
};

// user prompt (string content)
t("user-prompt", parseEntry(JSON.stringify({type:"user", message:{content:"帮我看下代码"}})),
  [{t:"prompt", text:"帮我看下代码"}]);
// harness wrapper skipped
t("skip-wrapper", parseEntry(JSON.stringify({type:"user", message:{content:"<command-name>/goal</command-name>"}})), []);
// assistant text + usage (attached to the single event)
t("asst-text", parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"回答内容"}], usage:{input_tokens:100, output_tokens:20}}})),
  [{t:"say", text:"回答内容", usage:{input:100, output:20}}]);
// tool use
const tu = parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"tool_use", id:"t1", name:"Bash", input:{command:"ls -la"}}]}}));
t("tool-use", [tu[0]?.t, (tu[0] as any)?.name, (tu[0] as any)?.input], ["tool", "Bash", {command:"ls -la"}]);
// tool result (array content)
const tr = parseEntry(JSON.stringify({type:"user", message:{content:[{type:"tool_result", tool_use_id:"t1", content:[{type:"text", text:"file1\nfile2"}]}]}}));
t("tool-result", [tr[0]?.t, (tr[0] as any)?.id, (tr[0] as any)?.output], ["toolResult", "t1", "file1\nfile2"]);
// usage attached to first event only (text + tool in one message → tool has no usage)
const multi = parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"hi"},{type:"tool_use",id:"t2",name:"Read",input:{}}], usage:{input_tokens:5, output_tokens:2}}}));
t("usage-once", [(multi[0] as any).usage, (multi[1] as any).usage], [{input:5,output:2}, undefined]);
// sidechain skipped
t("sidechain", parseEntry(JSON.stringify({type:"assistant", isSidechain:true, message:{content:[{type:"text",text:"内部"}]}})), []);
// thinking skipped
t("thinking", parseEntry(JSON.stringify({type:"assistant", message:{content:[{type:"thinking",thinking:"..."}]}})), []);
// summaries
t("sum-bash", summarizeTool("Bash", {command:"grep -r foo ."}), "$ grep -r foo .");
t("sum-read", summarizeTool("Read", {file_path:"/a/b.ts"}), "Read /a/b.ts");
t("sum-write", summarizeTool("Write", {file_path:"/a/b.txt"}), "Write /a/b.txt");
t("sum-unknown", summarizeTool("MyTool", {q:"hello"}), "MyTool: hello");
