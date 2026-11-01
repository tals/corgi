# Starting and resuming agents

Use **New ▾** in the sidebar or **prefix c** to open the picker. It starts an
agent or terminal in a new tab. You can also run `claude` or `codex` in any
pane; Corgi discovers them automatically.

## Start an agent

Choose a provider and press Enter. **New** repeats the workspace's last provider,
falling back to the last provider used anywhere, then Codex. **New terminal**
(or `t` in the picker) starts a shell without changing that choice.

The picker title names the destination. It follows the focused agent's checkout
when that agent works in a linked worktree; otherwise it uses the focused pane's
directory, falling back to the workspace directory. Press `w` to choose or
plan a worktree; see [Create or choose a worktree](workspaces.md#create-or-choose-a-worktree).
Nothing is created merely by browsing.

Built-in providers appear when installed and not known to be signed out.
An inconclusive account check does not hide them. Use `corgi which codex` or
`corgi which claude` to inspect binary discovery. `CORGI_CODEX_BIN` and
`CORGI_CLAUDE_BIN` can select explicit executables before runtime startup.

Each provider has its own **YOLO** checkbox, initially off. Click it or press
`y` on that row to change it; this does not launch anything. The choice is
remembered across viewers and recovery:

| Provider | Flag enabled by YOLO |
| --- | --- |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Claude Code | `--dangerously-skip-permissions` |

With YOLO off, the provider's normal permission settings apply. Launcher model
previews reflect provider configuration; Corgi does not override the interactive
agent's model with its own activity-summary model.

## Resume or find a conversation

The picker lists recent closed conversations from its destination folder.
Enter resumes one in a new tab. **Show more** or `/` opens the full history;
search matches titles, branch names and prompts/messages. Tab broadens the scope
from this folder to the workspace to everywhere. Esc clears search, then collapses it.
Selecting a conversation already running focuses its existing pane.

A recoverable recently closed agent returns with its saved command and output.
Otherwise Corgi uses the provider's resume command and the launcher's provider
flags. Resuming does not change the provider that **New** repeats.
A Claude session still running in Claude's background daemon is attached
instead; closing that tab leaves the background session running.

**prefix u** reopens the last recoverable closed agent in the workspace.
Corgi keeps up to eight; closed shells and agents without a known session ID
cannot be reopened this way. Recovery after a crash restores recorded agents
asleep; focusing their panes starts the resume command.

History excludes SDK runs and subagents. The short recent list also omits
commit-only conversations, which search can still find. Conversations whose
folders no longer exist cannot be resumed from this list. An agent that exits
with an error leaves its last output and exit code visible until its tab closes.

## Manage agents

Choose **Manage agents** or press `m` in the picker, or open its section in
**Corgi setup** (**prefix i**). Both show the same controls. The view lists the
accounts and saved commands in the launcher, **Active** and then **Hidden** in
this workspace, followed by **Add agent**: a strip of agents, each with its
brand mark, and **+ Custom command**. Selecting the strip opens the focused
agent's list: every account Corgi finds for it, ✓ those in the list and +
those out of it, whether removed with their folders still there or hidden
from the launcher, then **+ New … account** where Corgi can sign in to it.
**←** and **→** move along the strip and **↓** into the list. Once opened,
the strip keeps the room its longest list needs, so moving between agents
doesn't resize it; a search still can.
The search starts focused. **Tab** or **↓** moves into the list; **↑** enters
at the last row. Arrows wrap around the list; **Tab** or **Shift-Tab** returns
to search. On a row,
**↵** renames an account or edits a command; under **Add agent**, it adds a
removed account back, goes to the row of one in the list, or signs in to a new
one.
**Space**, or a click on its check, toggles **Show in** *workspace*: the row
leaves or rejoins the picker in the current workspace only, and reads dimmed
in Manage agents while hidden there. A narrow card heads that column with the
workspace's name. `corgi launcher hide AGENT` and `corgi launcher show AGENT`
do the same from a script, and `corgi launcher list` says what each workspace
shows.
Hold **⌫** or **Delete** for 1.5 seconds to remove any row while the corgi
buries it; releasing early restores it. Saved commands are deleted. Folders
Corgi created are signed out and deleted. A default account, or a folder Corgi
didn't create, leaves the list with its files and sign-in intact and waits
under its agent in **Add agent**, where **↵** adds it back. Close any agents
using a secondary account before removing it.
In search, those keys only edit text.
**Esc** returns from the command editor to Manage agents without saving,
cancels a rename or hold, or closes the list.
**← New tab** returns to the picker; the Left arrow does the same from the
list or an empty search. In setup, **← Settings** returns focus to the section
list. The launcher cards slide between views and share a width.
On wide terminals, accounts also show their usage and reset countdowns.
Adding an account, custom command, or previously removed row shows a brief
**✓ Added …** overlay without taking keyboard focus. New accounts are named
from their email domain (`me@acme.com` becomes `acme`). Common mail providers,
including Gmail, Outlook, Yahoo, iCloud, Proton and Fastmail, use the mailbox
instead (`me@gmail.com` becomes `me`). Duplicate names get a numbered suffix;
an explicitly supplied name is kept.

## Save a launch command

In Manage agents, choose **+ Custom command**:

1. Paste a command and review its resolved command, account, model and permissions.
2. Adjust its suggested name, then choose **Add**.
3. Choose its row again to edit it. An empty command cannot be saved.

Up to six commands can be saved, each up to 2,048 bytes. Names and visibility
are shared across viewers and survive reload and recovery.

For example, `MY_PROJECT=demo claude --model opus` preserves the environment
assignment and arguments. Preview resolves aliases and simple forwarding
functions from shell startup configuration; saving freezes that expansion.
Later alias changes do not change an existing saved command. Editing and
saving its command source resolves it again.

Preview does not execute the agent command. Complex shell functions are rejected;
paste their underlying command instead. Launch uses an interactive, non-login
shell, so definitions belong in `.bashrc`, `.zshrc` or fish configuration,
not only in another running shell. Normal variable expansion happens at launch.

Custom commands keep their own options and account/profile settings.
Built-in YOLO toggles do not rewrite them. A custom profile is not hidden merely
because the default provider account is signed out.

## Several accounts

Each provider's row is your default account. Named in Manage agents, it reads
like the others, such as **Claude Code · acme**; the name stays with the
default, whoever signs in to it. Every other account Corgi knows
gets a row under it, such as **Claude Code · work**, with its own model,
account, plan and usage and its own YOLO and launcher membership, and starts its agents in
that account. A row whose account is signed out says **Sign in**, and choosing
it signs in again over the panes. Resume lists conversations from every
account and names the account of those that aren't the default's; resuming one
starts it there again. A named default is named there too, once its agent has
another account.

An account is the provider's settings folder, the one `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` picks. Corgi knows:

- accounts it adds: **+ New … account** under **Add agent** in Manage agents,
  or `corgi account add`;
- folders you add with `corgi account add claude work --dir FOLDER`;
- the accounts Omarchy keeps (`omarchy agent account add`), under Omarchy's
  labels;
- folders an agent ran in, such as one typed as `CLAUDE_CONFIG_DIR=… claude`,
  once someone signed in there.

Adding an account opens a sign-in over the panes. It runs the agent's own
first run in a new folder, in a frame that says what the agent's screen leaves
out, such as how to sign in from another computer; selecting in the agent's
screen copies only its text. The folder waits in a private temporary folder
until you're signed in, then moves in. Corgi opens the agent in a new tab
automatically and shows **Account added** with its name. The account is named
for who signed in: the company of a work address, such as **acme** for
me@acme.com, or the mailbox of a personal one.
In the viewer, the sign-in screen pulls into the confirmation's checkmark
while the new agent starts. Turning Visual flourishes off keeps a static
confirmation. Typing or clicking finishes the transition immediately.
Rename it in Manage agents; its folder, numbered, stays where it is. **ctrl c**
cancels without confirmation: Corgi signs out any login made there and deletes
the folder, then returns to Manage agents with the search and selection intact.
When the login is one another account has already, the frame says so before
keeping it. `corgi account add` shows the same in a terminal of its own.

A new account's folder links your default account's setup: instructions,
settings, skills, agents, commands and plugins. Its login and conversations
stay its own. Each account gets Corgi's
hooks; Codex asks you to trust them once per account. `corgi account list`
shows every account and who signed in, `corgi account login NAME` signs in
again and `corgi account rename NAME NEW` renames one, `claude/default` the
default. From the CLI, `corgi account remove NAME` removes an account. Removing one
Corgi made signs it out and deletes its folder; removing another forgets it
and leaves its folder. Corgi won't remove an account an agent runs in.
Folder deletion requires Corgi's creation record to match the directory.
Replaced folders and older accounts without that record are only forgotten.

## Accounts and usage

The picker shows available model, account, plan and rate-limit information.
Unknown configuration stays **Provider default**; unknown account information
stays unknown. Opening the picker does not send a model prompt.

Usage percentages mean **used**, followed by a reset countdown where available.
Missing limits are omitted; a reported zero remains visible. Recent cached
readings can remain visible after a failed refresh. Once too old, they show
**—**, as does missing usage; an unsupported usage query does not itself
make the provider unusable.

The daemon reads usage on its own, with or without a viewer open: every 2½
minutes while someone has used a viewer in the last five minutes, and every
10 minutes otherwise. A reading counts as stale after 20 minutes. Folders
signed in to the same account share one reading, taken through the folder
that worked last; when its login stops working, the next folder takes over.

In the usage card, each limit's spark runs from the window's start to its
reset. A monthly spend limit's spark shows the last four weeks instead, in
two-day cells: each bar is the spend in its days, scaled to the busiest, and
days before the month began are dimmer. A slot no reading covers is a faint
stipple rather than a guess; for spend, that's any day Corgi didn't read
along with the day before.

Explicit accounts or profiles in saved commands get separate previews.
A cached public identity is a hint, not proof that its credentials still work.
Corgi's account cache stores metadata, not credentials; provider tools retain
responsibility for login. See [settings and troubleshooting](reference.md#settings-and-troubleshooting)
and [agent internals](agents.md) for further details.
