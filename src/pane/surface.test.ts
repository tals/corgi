import {test,expect} from "bun:test";
import {Terminal} from "./terminal";
import {capture} from "./surface";
const links=(t:Terminal)=>t.native({op:"links"}) as {uri:string;start:number;end:number}[];
test("named hyperlinks survive capture and a second terminal render without leaking",()=>{
  const ts=Array.from({length:3},()=>Terminal.create(32,3)),[t,mirror,host]=ts;
  try{t.feed("\x1b]8;id=docs;https://example.com/docs\x1b\\\x1b[4mDocs 界\x1b]8;;\x1b\\\x1b[0m plain");
    const captured=capture(7,t);expect(captured.lines[0]).toContain(";https://example.com/docs\x1b\\");
    mirror.feed(captured.lines[0]);host.feed(capture(7,mirror).lines[0]);const found=links(host);expect(found).toHaveLength(1);
    expect(found[0].uri).toBe("https://example.com/docs");expect(found[0].start).toBe(0);expect(found[0].end).toBe(7);
    expect(capture(7,t).lines[0]).toBe(captured.lines[0]);
  }finally{for(const t of ts)t.destroy();}
});
test("hyperlinks retain completed frame during synchronized output and disappear on overwrite",()=>{
  const t=Terminal.create(20,2);try{
    t.feed("\x1b]8;;https://example.com/old\x1b\\OLD\x1b]8;;\x1b\\");const before=capture(1,t);
    t.feed("\x1b[?2026h\x1b[2J\x1b[HNEW");expect(capture(1,t).lines[0]).toBe(before.lines[0]);
    t.feed("\x1b[?2026l");expect(capture(1,t).lines[0]).not.toContain("\x1b]8;");
  }finally{t.destroy();}
});
test("plain web links map Unicode cells, trim punctuation and preserve explicit targets",()=>{
  const t=Terminal.create(100,4);try{
    t.feed("界é (https://example.com/a_(b)). plain\r\n\x1b]8;;https://explicit.example/\x1b\\https://printed.example/\x1b]8;;\x1b\\ \x1b[8mhttps://hidden.example/\x1b[0m");
    const found=links(t);expect(found).toHaveLength(2);expect(found[0].uri).toBe("https://example.com/a_(b)");
    expect(found[0].start).toBe(5);expect(found[0].end).toBe(30);expect(found[1].uri).toBe("https://explicit.example/");
  }finally{t.destroy();}
});
test("plain links span soft wraps but not hard newlines and remain snapshot owned",()=>{
  const t=Terminal.create(20,5);try{
    const url="https://example.com/a-long-path";t.feed(url+" ");const before=capture(9,t),found=links(t);
    expect(found).toHaveLength(2);for(const link of found)expect(link.uri).toBe(url);
    for(const line of before.lines.slice(0,2))expect(line).toContain(`;${url}\x1b\\`);
    t.feed("\x1b[?2026h\x1b[2J\x1b[Hhttps://new.example/");expect(capture(9,t).lines[0]).toBe(before.lines[0]);
    t.feed("\x1b[?2026l\x1b[2J\x1b[Hhttp://\r\nexample.com");capture(9,t);expect(links(t)).toHaveLength(0);
  }finally{t.destroy();}
});
