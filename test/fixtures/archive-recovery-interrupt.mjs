// Fault injection is confined to an already completed, test-owned thread.
import fs from "node:fs";
import path from "node:path";
import { AppServerCodexRunner } from "../../src/codex/app-server-runner.ts";
import { APP_SERVER_SOCKET_RELAY } from "../../src/codex/app-server-socket-relay.ts";
import { SystemErrorRecoveryCoordinator } from "../../src/server/system-error-recovery.ts";

const [root, socket, threadId, turnId, phase] = process.argv.slice(2);
const runner = new AppServerCodexRunner({codexHome:root,catalogSource:"native",transport:{
  command:process.execPath,args:["-e",APP_SERVER_SOCKET_RELAY,socket],mode:"daemon-proxy"}});
const ledger = path.join(root,"archive-recovery-fixture.json");
const backend = {
  systemErrorLifecycleRecovery:true,
  async readThreadSnapshot() {
    const snapshot=await runner.readThreadSnapshot(threadId);
    // A synthetic workspace-routing error chooses the product recovery path.
    return {...snapshot,state:{...snapshot.state,runtimeStatus:"systemError",activeTurnId:undefined,activeFlags:[],
      lastTurnFailure:{turnId,code:"workspace-routing"}},turns:[{id:turnId,status:"failed",messages:[]}]};
  },
  async recoverSystemError(input) {
    if (!input.lifecycle.restoring) {
      input.lifecycle.beforeArchive();await runner.archiveThread(threadId);input.lifecycle.archived();
      if (phase==="after-archive") process.kill(process.pid,"SIGKILL");
    }
    const lifecycle={...input.lifecycle,restored() {
      if(phase==="during-compensation") process.kill(process.pid,"SIGKILL");
      input.lifecycle.restored();
    }};
    return runner.recoverSystemError({...input,lifecycle:{...lifecycle,restoring:true}});
  }
};
const coordinator=new SystemErrorRecoveryCoordinator({filePath:ledger,backend:()=>backend,lease:()=>()=>{},notice:async()=>{},cooldownMs:0});
try { await coordinator.request({hostId:"local",threadId,turnId});
  if(phase!=="recover") console.error(phase,coordinator.status({hostId:"local",threadId,turnId})); }
finally { await coordinator.stop();await runner.close(); }
