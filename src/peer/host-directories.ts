import fs from "node:fs";
import path from "node:path";
import { ProcessIDEHostTransport } from "../ide/transport.js";
import { runIDEHost } from "../ide/host-command.js";

/** Device filesystem access follows the same registered native host as Codex.
 * No remote path is resolved against the machine hosting the Connector. */
export class PeerHostDirectories {
  private readonly transport: ProcessIDEHostTransport;
  constructor(readonly hostId = "local", private readonly codexHome?: string) {
    this.transport = new ProcessIDEHostTransport({ codexHome });
  }
  async canonical(directory: string): Promise<string> {
    if (this.hostId !== "local") return this.transport.canonicalDirectory(this.hostId, directory);
    const actual = fs.realpathSync(directory); if (!fs.statSync(actual).isDirectory()) throw new Error("Not a directory"); return actual;
  }
  async assertImages(cwd: string, images: readonly string[]): Promise<void> {
    if (this.hostId !== "local") {
      await runIDEHost(this.hostId, String.raw`
        const fs=require('node:fs'),path=require('node:path'),input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
        const root=fs.realpathSync(input.cwd);
        for(const image of input.images){const actual=fs.realpathSync(image),relative=path.relative(root,actual);
          if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw Error('Image outside workspace');}
        process.stdout.write('null');`, { cwd, images }, undefined, 30000, { codexHome: this.codexHome }); return;
    }
    const root = fs.realpathSync(cwd);
    for (const image of images) {
      const relative = path.relative(root, fs.realpathSync(image));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Image is outside the granted workspace");
    }
  }
  async standalone(stateDir: string, operationId: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new Error("Invalid workspace identity");
    if (this.hostId !== "local") return runIDEHost<string>(this.hostId, String.raw`
      const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
      const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
      let dir=fs.realpathSync(os.homedir());
      for(const part of ['.codex-im-gateway','workspaces',input.operationId]){
        dir=path.join(dir,part);try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
        if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory()||fs.realpathSync(dir)!==dir)throw Error('Unsafe workspace');
      }process.stdout.write(JSON.stringify(dir));`, { operationId }, undefined, 30000, { codexHome: this.codexHome });
    let dir = fs.realpathSync(stateDir);
    for (const part of ["workspaces", operationId]) {
      dir = path.join(dir, part);
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) throw new Error("Unsafe workspace");
    }
    return dir;
  }
}
