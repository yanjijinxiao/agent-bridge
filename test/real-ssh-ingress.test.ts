import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { REMOTE_IDE_SOCKET_PREPARE } from "../src/ide/remote-ingress.js";

const targets: Array<{ name: string; args: string[] }> = JSON.parse(process.env.CODEX_SSH_INGRESS_TEST_TARGETS ?? "[]");
const execute = promisify(execFile);
for (const target of targets.length ? targets : [{ name: "not-configured", args: [] }]) {
  test(`IDE ingress keeps one socket path across real SSH loss and reconnect (${target.name})`,
    { skip: !targets.length, timeout: 90000 }, async t => {
      const args = target.args.slice(0, -1);
      const destination = target.args.at(-1)!;
      const remote = async (cmd: string) => (await execute("ssh", [...args, destination, cmd], { timeout: 10000 })).stdout.trim();
      const home = await remote('mktemp -d "$HOME/abi-XXXXXXXX"');
      assert.match(home, /^\/[a-zA-Z0-9/_.-]+\/abi-[A-Za-z0-9]{8}$/);
      // A separate HOME keeps the production tunnel tree out of this test.
      t.after(() => remote(`rm -rf -- '${home}'`).then(() => {}));
      const id = randomBytes(12).toString("hex");
      // Linux 12 runs Node in a mount of the caller's working directory. Set
      // HOME inside Node too, so the real helper and sshd see the same inode.
      const script = (body: string, input: string) => remote(`cd '${home}' && node -e "process.env.HOME=process.cwd();eval(Buffer.from('${Buffer.from(body).toString("base64")}','base64').toString())" '${Buffer.from(input).toString("base64")}'`);
      const prepare = async () => JSON.parse(await script(REMOTE_IDE_SOCKET_PREPARE, JSON.stringify({ id }))).socketPath as string;
      const socket = await prepare();
      assert.equal(socket, `${home}/.local/share/codex-im-gateway/ingress/${id}/relay.sock`);
      const read = (code: string) => script("const file=Buffer.from(process.argv[1],'base64').toString(),fs=require('fs'),net=require('net');" + code, socket);
      const server = net.createServer(connection => connection.end("same-origin-fixture"));
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
      const port = (server.address() as net.AddressInfo).port;
      const probe = () => read("const s=net.connect(file);s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exitCode=1);");
      for (let i = 0; i < 2; i++) {
        const tunnel = spawn("ssh", [...args, "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes",
          "-N", "-R", `${socket}:127.0.0.1:${port}`, destination], { stdio: "ignore" });
        const closed = once(tunnel, "exit");
        try {
          let received: string | undefined;
          for (let attempt = 0; attempt < 15 && received === undefined; attempt++) {
            try { received = await probe(); } catch { await delay(100); }
          }
          assert.equal(received, "same-origin-fixture");
          await assert.rejects(prepare(), /Ingress socket preparation failed/);
          assert.equal(await probe(), "same-origin-fixture");
        } finally { tunnel.kill("SIGKILL"); await closed; }
        await assert.rejects(probe());
        const inode = await read("const s=fs.lstatSync(file,{throwIfNoEntry:false});console.log(s?JSON.stringify({uid:s.uid,mode:(s.mode&511).toString(8),owner:process.getuid()}):'gone')");
        t.diagnostic(`disconnected tunnel ${i+1}, socket ${inode}`);
        let recovered: string | undefined;
        for (let attempt = 0; attempt < 4 && !recovered; attempt++) {
          try { recovered = await prepare(); } catch { await delay(200); }
        }
        assert.equal(recovered, socket, "sshd did not release the private forward after disconnect");
      }
      // Some sshd versions unlink a lost forward immediately. Force a stale
      // inode separately so both legitimate recovery paths are observed.
      // The remote Node wrapper can itself be PID 1. Kill a dedicated child
      // and wait for its exit, so a disconnected SSH client is never mistaken
      // for proof that the socket's listening process died.
      const orphan = await read(`
        const owner=require('node:child_process').spawn(process.execPath,['-e',
          "const f=process.argv[1];require('net').createServer().listen(f,()=>{require('fs').chmodSync(f,0o600);console.log('ready')});",file],
          {stdio:['ignore','pipe','inherit']});
        owner.stdout.once('data',()=>owner.kill('SIGKILL'));
        owner.once('exit',(_code,signal)=>console.log(signal));
      `);
      assert.equal(orphan, "SIGKILL");
      assert.equal(await read("console.log(fs.lstatSync(file).isSocket())"), "true");
      assert.equal(await read("const s=net.connect(file);s.on('connect',()=>{console.log('live');s.destroy()});s.on('error',e=>console.log(e.code));"), "ECONNREFUSED");
      assert.equal(await prepare(), socket);
      assert.equal(await read("console.log(fs.existsSync(file))"), "false");
      await read("fs.writeFileSync(file,'owner');");
      await assert.rejects(prepare());
      assert.equal(await read("console.log(fs.readFileSync(file,'utf8'))"), "owner");
      await read("fs.unlinkSync(file);fs.symlinkSync('missing',file);");
      await assert.rejects(prepare());
      assert.equal(await read("console.log(fs.lstatSync(file).isSymbolicLink())"), "true");
    });
}
