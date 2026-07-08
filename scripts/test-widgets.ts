import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoredBlockerAction, permissionPresentation, planProgress, shouldIgnoreNonVisibleBlocker, structuredQuestion, todoProgress } from "../src/bridge.js";

test("mid", () => assert.deepEqual(todoProgress({todos:[{status:"completed"},{status:"in_progress",content:"step 2"},{status:"pending"}]}), {completed:1,total:3,current:"step 2"}));
test("done", () => assert.deepEqual(todoProgress({todos:[{status:"completed"},{status:"completed"}]}), {completed:2,total:2,current:"All done"}));
test("activeForm-fallback", () => assert.deepEqual(todoProgress({todos:[{status:"in_progress",activeForm:"Running X"}]}), {completed:0,total:1,current:"Running X"}));
test("empty", () => assert.deepEqual(todoProgress({todos:[]}), null));
test("no-field", () => assert.deepEqual(todoProgress({}), null));
test("plan-mid", () => assert.deepEqual(planProgress({plan:[{status:"completed",step:"A"},{status:"in_progress",step:"B"},{status:"pending",step:"C"}]}), {completed:1,total:3,current:"B"}));
test("plan-done", () => assert.deepEqual(planProgress({plan:[{status:"completed",step:"A"}]}), {completed:1,total:1,current:"All done"}));
test("plan-empty", () => assert.deepEqual(planProgress({plan:[]}), null));

const askInput = {questions:[{question:"Which DB?",header:"DB",options:[{label:"Postgres",description:"relational"},{label:"Redis",description:"kv"}]}]};
test("aq-structured", () => assert.deepEqual(structuredQuestion({name:"AskUserQuestion",input:askInput}),
  {question:"Which DB?",header:"DB",options:[{label:"Postgres",description:"relational"},{label:"Redis",description:"kv"}]}));
test("aq-not-askuserquestion", () => assert.deepEqual(structuredQuestion({name:"Bash",input:askInput}), null));
test("aq-multi-question-unsupported", () => assert.deepEqual(structuredQuestion({name:"AskUserQuestion",input:{questions:[askInput.questions[0],askInput.questions[0]]}}), null));
test("aq-no-options", () => assert.deepEqual(structuredQuestion({name:"AskUserQuestion",input:{questions:[{question:"Q",options:[]}]}}), null));
test("aq-missing-desc-defaults", () => assert.deepEqual(structuredQuestion({name:"AskUserQuestion",input:{questions:[{question:"Q",options:[{label:"A"}]}]}}),
  {question:"Q",header:"",options:[{label:"A",description:""}]}));
test("aq-undefined", () => assert.deepEqual(structuredQuestion(undefined), null));

const permMenu = {title:"Approve?",options:[{digit:"1",label:"Yes"},{digit:"2",label:"No"}]};
const permClass = {kind:"permission" as const,allow:{digit:"1",label:"Yes"},deny:{digit:"2",label:"No"}};
test("perm-menu", () => assert.deepEqual(permissionPresentation(permMenu, permClass, undefined), "emit"));
test("perm-pending-tool", () => assert.deepEqual(permissionPresentation(null, null, {name:"Bash",input:{}}), "emit"));
test("perm-visible-unparseable", () => assert.deepEqual(permissionPresentation(null, null, undefined), "notify"));
test("ignore-non-visible-no-menu", () => assert.deepEqual(shouldIgnoreNonVisibleBlocker(null, {rule:"weak_blocker",visibleBlocker:false}), true));
test("ignore-non-visible-with-menu", () => assert.deepEqual(shouldIgnoreNonVisibleBlocker(permMenu, {rule:"weak_blocker",visibleBlocker:false}), false));
test("ignore-unknown-backend", () => assert.deepEqual(shouldIgnoreNonVisibleBlocker(null, {}), false));
test("ignored-blocker-startup", () => assert.deepEqual(ignoredBlockerAction(false, false), "idle"));
test("ignored-blocker-active-turn", () => assert.deepEqual(ignoredBlockerAction(true, false), "busy"));
test("ignored-blocker-idle-grace", () => assert.deepEqual(ignoredBlockerAction(true, true), "rearmIdle"));
