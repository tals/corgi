#!/usr/bin/env python3
"""PTY titles bind sessions; a read-only WebSocket observer supplies state."""
import pathlib, shlex, time, unittest
import smoke
from provider_sim import CodexObserver, TerminalAttachment, write_codex_terminal
import tempfile
tempfile.tempdir="/tmp"

A='01901234-1234-1234-1234-123456789abc'
B='01911234-1234-1234-1234-123456789abc'


def observer_field(name):
    # Preserve the inherited activity-summary fixture's small state interface.
    return property(lambda self: getattr(self.sim, name),
                    lambda self, value: setattr(self.sim, name, value))

class Titles(unittest.TestCase):
    run_cli=smoke.Runtime.run_cli
    rpc=smoke.Runtime.rpc
    command=smoke.Runtime.command
    raw_rpc=smoke.Runtime.raw_rpc
    until=smoke.Runtime.until
    session=smoke.Runtime.session
    panes=smoke.Runtime.panes
    errors=observer_field('errors')
    methods=observer_field('methods')
    ids=observer_field('ids')
    states=observer_field('states')
    turns=observer_field('turns')
    items=observer_field('items')
    paths=observer_field('paths')
    children=observer_field('children')
    wait_items=observer_field('wait_items')
    child_error=observer_field('child_error')
    waiting=observer_field('waiting')
    def setUp(self):
        self.client=None;self.client_file=None;self.proc=None
        smoke.Runtime.setUp(self)
        self.sim=CodexObserver(self.env['CODEX_HOME'],[A,B])
        self.turns.update({A:('old','completed'),B:('old-b','completed')})
        self.attachments=[]
        self.attachment=self.create_attachment(A)
        self.pane=self.attachment.pane
        self.until(lambda:self.state()['session']==A or self.errors)
        self.assertEqual(self.errors,[])
        self.command('pane.create', workspace=1, command='sleep 60')
    def create_attachment(self,session,arguments=None):
        directory=pathlib.Path(self.temp.name,'attachment-'+str(len(self.attachments)))
        fake=write_codex_terminal(directory/'codex',session)
        args=['--dangerously-bypass-approvals-and-sandbox','resume'] if arguments is None else arguments
        pane=self.command('pane.create',workspace=1,command=shlex.join([str(fake),*args]))['pane']
        attachment=TerminalAttachment(self,pane)
        self.attachments.append(attachment)
        return attachment
    def state(self):return self.attachment.state()
    def tearDown(self):
        self.sim.close()
        smoke.Runtime.tearDown(self)
    def title(self,value):self.attachment.send(value)
    def test_resume_passthrough_and_focus_completion(self):
        text=self.command('pane.read', target=self.pane, view='screen')['text']
        self.assertIn('ARGS:["--dangerously-bypass-approvals-and-sandbox", "resume"]',text)
        self.assertNotIn('--remote',text)
        self.assertEqual(self.state()['completed'],0)
        self.states[A]='active';self.turns[A]=('new','inProgress')
        self.until(lambda:self.state()['state']=='working')
        self.waiting=True;self.until(lambda:self.state()['state']=='blocked')
        self.waiting=False;self.states[A]='idle';self.turns[A]=('new','completed')
        self.until(lambda:self.state()['completed']==1)
        time.sleep(1);self.assertEqual(self.state()['completed'],1)
        self.title(B[:29]+'...');self.until(lambda:self.state()['session']==B)
        self.assertEqual(self.state()['completed'],0)
        self.turns[A]=('unrelated','completed');time.sleep(1)
        self.assertEqual(self.state()['completed'],0)
        self.assertEqual(self.errors,[])
    def test_ambiguous_prefix_does_not_rebind(self):
        self.ids.append(B[:-3]+'def');self.title(B[:29]+'...');time.sleep(1.5)
        self.assertNotEqual(self.state()['session'],B)
        self.ids.pop();self.until(lambda:self.state()['session']==B)
    def test_missing_title_prevents_updates(self):
        self.title('shell');time.sleep(.7)
        self.turns[A]=('after-title-gone','completed');time.sleep(1)
        self.assertEqual(self.state()['completed'],0)

    def test_resumed_work_does_not_freeze_after_protocol_falls_back_to_screen(self):
        self.assertEqual(self.state()['state'],'idle')
        # The provider disappears after a valid idle snapshot. The fallback must
        # keep observing the live terminal, rather than freezing its first result.
        self.ids=[]
        self.attachment.send('screen:idle')
        self.until(lambda:self.state()['source']=='screen',timeout=9)
        self.attachment.send('screen:working')
        self.until(lambda:self.state()['state']=='working')
        self.attachment.send('screen:idle')
        self.until(lambda:self.state()['state']=='idle')
        self.assertEqual(self.state()['completed'],0)
        self.sim.set_turn(A,'resumed-turn','inProgress')
        self.ids=[A,B]
        self.until(lambda:self.state()['source']=='protocol' and self.state()['state']=='working')

    def test_subagent_counts_waits_and_viewer_layout(self):
        from viewers import Viewer
        def child(ident,parent=A,status='active',flags=()):
            return {'id':ident,'parentThreadId':parent,'status':{'type':status,'activeFlags':list(flags)}}
        def wait(turn='new',status='inProgress',sender=A):
            return {'turnId':turn,'item':{'type':'collabAgentToolCall','tool':'wait','status':status,'senderThreadId':sender}}
        self.children=[child('c1'),child('c2'),child('old',status='idle'),child('unrelated',parent=B),child('c3',flags=['waitingOnApproval'])]
        self.states[A]='active';self.turns[A]=('new','inProgress')
        self.wait_items=[wait(turn='old'),wait(sender=B),wait()]
        expected={'running':2,'blocked':1,'waiting':True}
        self.until(lambda:self.state()['subagents']==expected)
        self.assertEqual(self.state()['activity'],'Waiting on agents')
        session=self.rpc(op='session.snapshot',protocol=1)
        self.assertEqual(next(p for p in session['panes'] if p['id']==self.pane)['agent']['subagents'],expected)
        self.viewers=[]
        viewer=Viewer(self)
        try:
            self.until(lambda:'↳2 !1' in viewer.poll()['data'])
            rows=smoke.screen_text(viewer.state['data'],100,30)
            line=next(i for i,r in enumerate(rows) if '↳2 !1' in r)
            self.assertIn('Waiting on',rows[line])
            self.assertEqual(rows[line][21:26],'↳2 !1')
            # Finishing/timing out the wait does not mean the children stopped.
            self.wait_items=[wait(status='completed')]
            expected['waiting']=False
            self.until(lambda:self.state()['subagents']==expected)
            self.until(lambda:'Waiting on agents' not in viewer.poll()['data'] and '◷' not in viewer.state['data'])
            self.children=[child('c1'),child('c2')]
            expected['blocked']=0
            self.until(lambda:self.state()['subagents']==expected)
            # Completion removes the badge entirely, without moving any rows.
            self.children=[child('c1',status='idle'),child('c2',status='idle')]
            self.until(lambda:self.state()['subagents']=={'running':0,'blocked':0,'waiting':False})
            self.until(lambda:'↳' not in viewer.poll()['data'])
            plain=smoke.screen_text(viewer.state['data'],100,30)
            self.assertEqual(rows[line-1],plain[line-1])
            # No children means no item-history queries in the common case.
            self.children=[]
            self.until(lambda:self.state()['subagents']['running']==0)
            time.sleep(.7);before=self.methods.count('thread/items/list')
            time.sleep(.7);self.assertEqual(self.methods.count('thread/items/list'),before)
        finally:viewer.close()
        self.assertEqual(self.errors,[])

    def test_partial_child_page_does_not_publish_partial_count_or_lose_completion(self):
        self.children=[{'id':str(i),'parentThreadId':A,'status':{'type':'active'}} for i in range(3)]
        self.until(lambda:self.state()['subagents']['running']==3)
        self.child_error=True
        self.turns[A]=('new','completed')
        self.until(lambda:self.state()['completed']==1 and self.state()['subagents']['running']==0)
        self.child_error=False
        self.until(lambda:self.state()['subagents']['running']==3)
        self.title(B[:29]+'...')
        self.until(lambda:self.state()['session']==B and self.state()['subagents']['running']==0)
        self.assertEqual(self.errors,[])

if __name__=='__main__':unittest.main()
