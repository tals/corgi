/** Add after the CPU harness has assigned distinct provider/session IDs.
 * Only CPU_RICH_TRANSCRIPTS=1 adds history; terminal output and hooks stay the same.
 */
export function richTranscript(source: string): string {
  const anchor = "let turn=0;";
  if (source.split(anchor).length !== 2) throw Error("Ordinary provider fixture changed");
  const history = String.raw`
if(process.env.CPU_RICH_TRANSCRIPTS==='1' && provider==='claude') {
  const session=JSON.parse(readFileSync(transcript,'utf8').split('\n')[0]).payload.id;
  const timestamp=new Date(Date.now()-60000).toISOString();
  appendFileSync(transcript,JSON.stringify({
    type:'assistant',sessionId:session,timestamp,
    message:{id:'historical-'+session,model:'claude-sonnet-4-5',
      usage:{input_tokens:1000,output_tokens:100,cache_read_input_tokens:200},
      content:[{type:'text',text:'Previously completed fixture work.'}]}
  })+'\n');
  appendFileSync(transcript,JSON.stringify({type:'system',subtype:'turn_duration',sessionId:session,timestamp})+'\n');
}
`;
  return source.replace(anchor, history + anchor);
}
