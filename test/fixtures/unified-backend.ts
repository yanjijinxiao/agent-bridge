import { APP_SERVER_BACKEND_CAPABILITIES, type CodexThreadState } from '../../src/codex/backend.js';
import { CodexAppServerGateway } from '../../src/codex/app-server-gateway.js';

/** Native-port fake only. Wire and core identity are tested independently by shared-native-core. */
export function unifiedBackend(t: {after(fn: () => unknown): unknown}) {
  const state: CodexThreadState = { threadId: 'thread', persistence: 'active', runtimeStatus: 'idle', activeFlags: [] };
  const calls: Array<{method: string; args: any[]}> = [];
  let failure: Error | undefined;
  const record = (method: string, args: any[]) => { calls.push({method, args}); if(failure) throw failure; };
  const app: any = {
    id: 'app-server', capabilities: APP_SERVER_BACKEND_CAPABILITIES, executionLifetime: 'independent',
    async run(input: any) { record('run',[input]); await input.onTurnStarted?.({threadId:input.threadId ?? 'created',turnId:'turn'});
      return {threadId:input.threadId ?? 'created',turnId:'turn',text:'native',raw:''}; },
    async inspectThread(id: string, observation?: unknown) { record('inspectThread',[id,observation]); return {...state,threadId:id}; },
    async readThreadSnapshot(id: string) { record('readThreadSnapshot',[id]); return {state:{...state,threadId:id},turns:[]}; },
    async listProjects() { record('listProjects',[]); return {backend:'app-server',projects:[]}; },
    async listThreads() { record('listThreads',[]); return [{...state}]; },
    async listSessionCatalog() { record('listSessionCatalog',[]); return {backend:'app-server',source:'app-server-storage',hostIds:['local'],complete:true,threads:[{...state}],warnings:[]}; },
    async getHistory() { record('getHistory',[]); return []; }, async getHistoryPage() { record('getHistoryPage',[]); return {messages:[]}; },
    async getRuntimeInfo() { record('getRuntimeInfo',[]); return {}; }, async warmUp() {record('warmUp',[]);},
    async steer(input: any) {record('steer',[input]); return {status:'accepted',threadId:input.threadId,turnId:input.expectedTurnId};},
    async stop(...args:any[]) {record('stop',args); return 'interrupted';},
    async addQueuedSubmission(input:any) {record('addQueuedSubmission',[input]); return {id:'queued',clientUserMessageId:input.clientUserMessageId};},
    async listQueuedSubmissions() {record('listQueuedSubmissions',[]); return {data:[]};},
    async deleteQueuedSubmission(...args:any[]) {record('deleteQueuedSubmission',args); return true;},
    async runQueuedSubmission(input:any) {record('runQueuedSubmission',[input]); return {threadId:input.threadId,turnId:'queued-turn',text:'queued',raw:''};},
    async readNativeTurnLifecycle() {record('readNativeTurnLifecycle',[]); return {status:'completed',source:'native-event',text:'done'};},
    close() {}
  };
  for(const method of ['listModels','getAccountRateLimits','getGoal','setGoal','clearGoal','archiveThread','unarchiveThread','deleteThread'])
    app[method] = async (...args:any[]) => {record(method,args); return method === 'listModels' ? [] : undefined;};
  const gateway = new CodexAppServerGateway({appServerBackend:app}); t.after(()=>gateway.close());
  return {gateway, app, state, calls, fail(error?: Error) {failure=error;}};
}
