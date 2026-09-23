"""Drive the actual viewer through its test-only stdio interface."""
import json, pathlib, select, subprocess
EXE=str(pathlib.Path(__file__).resolve().parents[1]/"zig-out/bin/corgi")

class Viewer:
    def __init__(self, test, cols=100, rows=30):
        self.test=test
        self.events=[]
        self.closed=False
        self.proc=subprocess.Popen([EXE,'__viewer-test'],env=test.env,cwd=test.temp.name,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        test.viewers.append(self)
        self.request(op='size',cols=cols,rows=rows)
    def request(self, **request):
        self.proc.stdin.write(json.dumps(request)+'\n');self.proc.stdin.flush()
        self.test.assertTrue(select.select([self.proc.stdout],[],[],5)[0], 'viewer response timeout')
        line=self.proc.stdout.readline()
        if not line:
            self.proc.wait(timeout=2)
            self.test.fail('viewer exited: '+self.proc.stderr.read())
        self.state=json.loads(line)
        self.events=[event for event in self.events if not event.get('_display')]
        self.events.extend(json.loads(line) for line in self.state['effects'].splitlines() if line)
        if self.state['rang']:self.events.append(dict(type='bell',kind=self.state['bell_kind']))
        self.events.append(dict(type='frame',data=self.state['data'],_display=True))
        if self.state['detached']:self.events.append(dict(type='detach'))
        self.events=self.events[-256:]
        return self.state
    def input(self, data):return self.request(op='input',data=data)
    def action(self,name,value=''):return self.request(op='action',name=name,value=value)
    def poll(self):return self.request(op='poll')
    def focus(self,pane):return self.request(op='focus',pane=pane)
    def close(self):
        if self.closed:return
        self.closed=True
        if self.proc.poll() is None:self.proc.terminate()
        self.proc.wait(timeout=3)
        for stream in (self.proc.stdin,self.proc.stdout,self.proc.stderr):
            try:stream.close()
            except BrokenPipeError:pass

def pump(test):
    client=getattr(test,'client',None)
    if client is not None and not client.closed and not client.state['detached']:
        client.poll()
