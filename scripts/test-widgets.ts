import { ignoredBlockerAction, permissionPresentation, planProgress, shouldIgnoreNonVisibleBlocker, structuredQuestion, todoProgress } from "../src/bridge.js";
const t=(n:string,g:unknown,w:unknown)=>console.log(`${JSON.stringify(g)===JSON.stringify(w)?"✅":"❌"} ${n}: ${JSON.stringify(g)}`);
t("mid", todoProgress({todos:[{status:"completed"},{status:"in_progress",content:"step 2"},{status:"pending"}]}), {completed:1,total:3,current:"step 2"});
t("done", todoProgress({todos:[{status:"completed"},{status:"completed"}]}), {completed:2,total:2,current:"All done"});
t("activeForm-fallback", todoProgress({todos:[{status:"in_progress",activeForm:"Running X"}]}), {completed:0,total:1,current:"Running X"});
t("empty", todoProgress({todos:[]}), null);
t("no-field", todoProgress({}), null);
t("plan-mid", planProgress({plan:[{status:"completed",step:"A"},{status:"in_progress",step:"B"},{status:"pending",step:"C"}]}), {completed:1,total:3,current:"B"});
t("plan-done", planProgress({plan:[{status:"completed",step:"A"}]}), {completed:1,total:1,current:"All done"});
t("plan-empty", planProgress({plan:[]}), null);

const askInput = {questions:[{question:"Which DB?",header:"DB",options:[{label:"Postgres",description:"relational"},{label:"Redis",description:"kv"}]}]};
t("aq-structured", structuredQuestion({name:"AskUserQuestion",input:askInput}),
  {question:"Which DB?",header:"DB",options:[{label:"Postgres",description:"relational"},{label:"Redis",description:"kv"}]});
t("aq-not-askuserquestion", structuredQuestion({name:"Bash",input:askInput}), null);
t("aq-multi-question-unsupported", structuredQuestion({name:"AskUserQuestion",input:{questions:[askInput.questions[0],askInput.questions[0]]}}), null);
t("aq-no-options", structuredQuestion({name:"AskUserQuestion",input:{questions:[{question:"Q",options:[]}]}}), null);
t("aq-missing-desc-defaults", structuredQuestion({name:"AskUserQuestion",input:{questions:[{question:"Q",options:[{label:"A"}]}]}}),
  {question:"Q",header:"",options:[{label:"A",description:""}]});
t("aq-undefined", structuredQuestion(undefined), null);

const permMenu = {title:"Approve?",options:[{digit:"1",label:"Yes"},{digit:"2",label:"No"}]};
const permClass = {kind:"permission" as const,allow:{digit:"1",label:"Yes"},deny:{digit:"2",label:"No"}};
t("perm-menu", permissionPresentation(permMenu, permClass, undefined), "emit");
t("perm-pending-tool", permissionPresentation(null, null, {name:"Bash",input:{}}), "emit");
t("perm-visible-unparseable", permissionPresentation(null, null, undefined), "notify");
t("ignore-non-visible-no-menu", shouldIgnoreNonVisibleBlocker(null, {rule:"weak_blocker",visibleBlocker:false}), true);
t("ignore-non-visible-with-menu", shouldIgnoreNonVisibleBlocker(permMenu, {rule:"weak_blocker",visibleBlocker:false}), false);
t("ignore-unknown-backend", shouldIgnoreNonVisibleBlocker(null, {}), false);
t("ignored-blocker-startup", ignoredBlockerAction(false, false), "idle");
t("ignored-blocker-active-turn", ignoredBlockerAction(true, false), "busy");
t("ignored-blocker-idle-grace", ignoredBlockerAction(true, true), "rearmIdle");
