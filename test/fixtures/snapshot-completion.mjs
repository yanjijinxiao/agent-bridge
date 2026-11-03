import readline from "node:readline";
const mode = process.argv[2];
const timestamp = JSON.parse(process.argv[3] ?? "null");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const terminal = mode === "system-error" ? "failed" : ["completed", "failed", "interrupted"].includes(mode) ? mode : "completed";
let starts = 0, nextTurnSent = false;
readline.createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line); if (m.id == null) return;
  const reply = result => send({id:m.id,result});
  if (m.method === "initialize") return reply({userAgent:"snapshot-completion-fixture"});
  if (m.method === "thread/start") return reply({thread:{id:"thread"}});
  if (m.method === "turn/start") {
    if (++starts !== 1) throw Error("input was replayed");
    return reply({turn:{id:"turn",status:"inProgress"}});
  }
  if (m.method === "thread/read") return reply({thread:{id:"thread",updatedAt:timestamp,status:{type:mode === "unloaded" ? "notLoaded" : mode === "system-error" ? "systemError" : mode === "active" ? "active" : "idle"}}});
  if (m.method === "thread/turns/list") {
    if (mode === "newer-start" && !nextTurnSent) {
      nextTurnSent = true;
      send({method:"turn/started",params:{threadId:"thread",turn:{id:"newer",status:"inProgress"}}});
    }
    return reply({data:[{id:mode === "other-turn" ? "other" : "turn",status:terminal,startedAt:timestamp,
      ...(m.params.itemsView === "notLoaded" || mode === "missing-items" ? {} : {items:[{type:"agentMessage",id:"answer",text:"EXACT_RESULT",phase:"final_answer"}]}),
      ...(mode === "unloaded-items" ? {items:[],itemsView:"notLoaded"} : {}),
      ...(terminal === "failed" ? {error:{message:"EXACT_FAILURE"}} : {})}],nextCursor:null});
  }
  if (m.method === "thread/unsubscribe") return reply({});
  send({id:m.id,error:{code:-32601,message:m.method}});
});
