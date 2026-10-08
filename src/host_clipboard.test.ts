import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { State, choose, relayTypes, saveImage, enable, type Result } from "./host_clipboard";
const b64=(value:string|Buffer)=>Buffer.from(value).toString("base64");
function event(s:State,types:string,pw="cHc="){s.packet(`type=read:status=OK:pw=${pw}`,0);s.packet(`type=read:status=DATA:pw=${pw}:mime=Lg==;${b64(types)}`,0);s.packet(`type=read:status=DONE:pw=${pw}`,0);}
function data(s:State,mime:string,bytes:string|Buffer){s.packet(`type=read:status=DATA:id=corgi:mime=${b64(mime)};${b64(bytes)}`,1000);}
const done=(s:State)=>s.packet("type=read:status=DONE:id=corgi",1000);
const png=Buffer.from([137,80,78,71,13,10,26,10]);
const fix=(n:ReturnType<State["notice"]>)=>n?.fix().map(p=>p.text.text()).join("");
test("text wins, and an image goes only into a pane",()=>{
  expect(choose("image/png text/plain\n",true)).toEqual({read:"text/plain"});
  expect(choose("image/tiff image/png\n",true)).toEqual({read:"image/png"});
  expect(choose("image/jpeg",true)).toEqual({read:"image/jpeg"});
  expect(choose("image/png",false)).toEqual({refuse:"not_pane"});
  expect(choose("image/tiff\n",true)).toEqual({refuse:"unsupported_image"});
  expect(choose("",true)).toBe("nothing");expect(choose("application/pdf",true)).toBe("nothing");
  expect(()=>saveImage("","image/webp",Buffer.from("RIFF\0\0\0\0WAVE"),0)).toThrow("NotImage");
  expect(()=>saveImage("","image/webp",Buffer.from("RIFF\0\0\0\0WEBPVP8 "),0)).toThrow("RelativeFolder");
});
test("paste events turn on only when the host supports them and allows reads",()=>{
  const s=new State();s.start(0);expect(s.takeOutput()).toBe("\x1b[?5522$p\x1b[>0q");s.modeReport(2,10);expect(s.takeOutput()).toBe("\x1b]5522;type=read:id=corgi-probe;Lg==\x1b\\");
  for(const status of ["OK","DATA","DONE"])s.packet(`type=read:status=${status}:id=corgi-probe`,20);
  expect(s.support).toBe("on");expect(s.out).toBe(enable);
  const denied=new State();denied.start(0);denied.modeReport(2,0);denied.packet("type=read:status=EPERM:id=corgi-probe",0);expect(denied.support).toBe("denied");expect(denied.out).not.toContain(enable);
  const unknown=new State();unknown.start(0);unknown.modeReport(0,0);expect(unknown.support).toBe("unsupported");
  const silent=new State();silent.start(0);silent.tick(2999);expect(silent.support).toBe("probing");silent.tick(3000);expect(silent.support).toBe("unsupported");
});
test("a paste reads with its one-time password and saves an image under its hash",()=>{
  const folder=mkdtempSync("/tmp/corgi-clipboard-");try{
    const s=new State();s.support="on";s.folder=folder;event(s,"image/png\n","b3RwLTE=");
    expect(choose(s.takeEvent()!,true)).toEqual({read:"image/png"});expect(s.takeEvent()).toBeNull();expect(s.request("image/png",0)).toBe(true);
    expect(s.out).toBe("\x1b]5522;type=read:id=corgi:pw=b3RwLTE=:name=Q29yZ2k=;aW1hZ2UvcG5n\x1b\\");expect(s.request("text/plain",0)).toBe(false);
    s.packet("type=read:status=OK:id=corgi",1000);data(s,"image/png",png);data(s,"text/plain","x");data(s,"image/png","IHDR");done(s);
    const result=s.takeResult()! as {path:string},bytes=Buffer.concat([png,Buffer.from("IHDR")]);
    expect(result.path).toBe(folder+"/"+createHash("sha256").update(bytes).digest("hex").slice(0,32)+".png");expect(readFileSync(result.path)).toEqual(bytes);expect(statSync(folder).mode&0o777).toBe(0o700);expect(statSync(result.path).mode&0o777).toBe(0o600);expect(s.takeResult()).toBeNull();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("a refused, stalled, damaged or oversized read reports why",()=>{
  const s=new State();s.support="on";event(s,"text/plain\n");s.takeEvent();s.request("text/plain",0);s.packet("type=read:status=EPERM:id=corgi",0);expect(s.takeResult()).toEqual({failed:"denied"});
  s.request("text/plain",0);s.tick(9999);expect(s.takeResult()).toBeNull();s.tick(10000);expect(s.takeResult()).toEqual({failed:"timed_out"});
  s.request("image/png",0);data(s,"image/png","not a png");done(s);expect(s.takeResult()).toEqual({failed:"not_image"});
  s.request("image/png",0);s.reading!.too_large=true;done(s);expect(s.takeResult()).toEqual({failed:"too_large"});
  s.request("text/plain",0);data(s,"text/plain","hi");done(s);expect(s.takeResult()).toEqual({text:"hi"});
});
test("an attempted image paste says why it can't work and what fixes it",()=>{
  const s=new State();expect(s.notice("cmd","Codex","nocap")).toBeNull();s.support="unsupported";s.terminalName("ghostty 1.3.1");
  let n=s.notice("cmd","Codex","nocap")!;expect(n.body.text()).toBe("Ghostty 1.3.1 can't send images over SSH.");expect(fix(n)).toBe("Use Ghostty Nightly to enable paste with ⌘+V.");expect(n.parts[1].kind).toBe("link");expect(n.parts[3].kind).toBe("key");
  n=s.notice("ctrl_shift","Codex","nocap")!;expect(n.body.text()).toBe("Ghostty on Linux can't send images over SSH yet.");expect(fix(n)).toBe("Only Ghostty Nightly on macOS can, for now.");
  const nightly=new State();nightly.support="unsupported";nightly.terminalName("ghostty 1.3.2-main+5dc28bb8e");expect(nightly.notice("ctrl","Codex","nocap")!.body.text()).toContain("on Linux");
  const tmux=new State();tmux.support="unsupported";tmux.terminalName("tmux 3.4");n=tmux.notice("ctrl","Claude","nocap")!;expect(n.body.text()).toBe("tmux sits between Corgi and your terminal.");expect(fix(n)).toBe("Run Corgi outside tmux to enable paste with ⌘+V.");
  const denied=new State();denied.support="denied";denied.terminalName("ghostty 1.3.2-main+5dc28bb8e");expect(fix(denied.notice("cmd","Codex","nocap"))).toBe("Set clipboard-read = ask to enable paste with ⌘+V.");
  const on=new State();on.support="on";expect(on.notice("cmd","Codex","nocap")).toBeNull();n=on.notice("ctrl","Codex","nocap")!;expect(n.body.text()).toBe("Codex reads the clipboard on nocap.");expect(fix(n)).toBe("Paste images from your Mac with ⌘+V.");
  const unnamed=new State();unnamed.support="unsupported";expect(unnamed.notice("cmd","Codex","nocap")!.body.text()).toBe("This terminal can't send images over SSH.");
});
test("a program that takes paste events is offered the text and the image together",()=>{
  const folder=mkdtempSync("/tmp/corgi-relay-");try{const s=new State();s.support="on";s.folder=folder;event(s,"text/plain image/png\n");const types=relayTypes(s.takeEvent()!);expect(types.length).toBe(2);expect(s.relay(types,0)).toBe(true);expect(s.out.endsWith(";dGV4dC9wbGFpbiBpbWFnZS9wbmc=\x1b\\")).toBe(true);data(s,"text/plain","hi");data(s,"image/png",png);done(s);const r=s.takeResult()! as Extract<Result,{relay:any}>;expect(r.relay.text).toBe("hi");expect(r.relay.image?.mime).toBe("image/png");expect(r.relay.image?.path.endsWith(".png")).toBe(true);}finally{rmSync(folder,{recursive:true,force:true});}
});
test("image paste's state shows in a few words",()=>{
  const s=new State();expect(s.status()).toBe("checking");s.support="on";expect(s.status()).toBe("● On");s.support="unsupported";expect(s.status()).toBe("○ no paste events");s.terminalName("tmux 3.4");expect(s.status()).toBe("○ tmux in between");s.support="denied";expect(s.status()).toBe("○ clipboard-read = deny");
});
