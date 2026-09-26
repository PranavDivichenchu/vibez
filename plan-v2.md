# Vibez v2 — the queue, the voice, the slate

Continues `plan.md`. Sections 16–23. Supersedes the first draft, kept at `.vibez/plan-v2.superseded.md`.

Three features were asked for: an iPad you can circle things on, a voice input, and several agents working at once with teammates watching. A design review changed the shape of all three.

What changed, in one table.

| First draft | Now | Why |
|---|---|---|
| One transport built first, three features on top | Actors first, transport fourth | Two of the three features need no network at all |
| "Multi-agent + presence" as one feature | The queue, and presence as a separate optional thing | The queue is the whole value and has no dependencies. The cursors are decoration with many. |
| Three dev servers in parallel | One measurement lane, serialized | 4–5GB of RAM, and parallel measurement makes numbers incomparable anyway |
| Voice lives on the iPad | Voice lives on the desktop first | Push-to-talk on a keyboard needs no pairing, no certificate, no pad |
| Whisper large-v3-turbo, 250ms partials | Short-form streaming model, honest numbers | Streaming Whisper chunks at 0.5–1s before it can decode anything |
| Graph-biased decoding is the unfair advantage | Snap-to-vocabulary is, and the circle already pins the nouns | `initial_prompt` is soft conditioning. A closed 50-word vocabulary deserves a deterministic match. |
| The iPad is an input surface | The iPad is a review surface | Circling a node is not faster than clicking it. Sitting back and looking at your app is the actual gain. |
| Yjs awareness | 100 lines over the existing socket | Nothing here is collaboratively edited |

Order follows dependency, not excitement. The queue ships alone, the voice ships alone, the slate needs the link, presence needs two people who asked for it.

---

## 16. Actors  ✅

The one thing everything below needs, and the only retrofit into v1 code.

v1 has a single implicit actor. Selection is *the* selection, `choreograph()` takes one event stream, the fence belongs to nobody because nobody else exists. Three agents in §17 break all of that on day one.

```ts
type ActorId = string        // 'local' | 'agent:<runId>' | 'pad:<deviceId>' | 'peer:<userId>'

interface Actor {
  id: ActorId
  kind: 'human' | 'agent' | 'pad'
  name: string
  hue: number                // rings and cursors only, never a node body
}

interface AgentEvent { /* ...existing... */ actor: ActorId }
interface Selection { nodes: SemanticKey[]; actor: ActorId; at: number }
interface Timeline  { steps: Step[]; actor: ActorId }
```

Do it before §17, in its own commit, with nothing else in flight. If it touches more than a dozen files the event model is wrong, and that is worth knowing while there is still only one feature sitting on it.

---

## 17. The queue  ✅

Several agents editing at once, one lane that measures, and a landing order that tells you which patches actually mattered.

### 17.1 The thing nobody else can show you

Two agents each report a win. Agent A takes 2.40s to 0.31s. Agent B takes 800ms to 240ms. Both true, both measured. Land A, and B's number quietly becomes 240ms to 230ms, because A removed the contention B was waiting on.

A terminal cannot show you that. A diff cannot. The canvas can, because it re-measures after every land and the node either stays warm or does not. This is the reason parallel agents belong in this product specifically, and it is the feature to build first.

### 17.2 Worktrees for editing

```
repo/
├── .git/
├── <your working tree>
└── .vibez/worktrees/
    ├── agent-a/          own branch, own .next, node_modules linked
    └── agent-b/
```

Editing is cheap: tokens and disk, no RAM. Three concurrent editing agents is comfortable. The fence in §17.3 keeps them off each other's files, so the worktrees rarely diverge in ways that matter.

`git worktree` does not populate `node_modules`. Link it from the main tree, give each worktree its own `.next`, and accept roughly 1GB of build cache per lane.

### 17.3 Fences, without a lock manager

§4.3's scope fence becomes an allocation, with one policy that makes deadlock structurally impossible: **nothing ever waits.**

- An actor requests a fence from its plan, before any write.
- Granted only if the file set is disjoint from every fence currently held.
- An agent that discovers it needs one more file gets the extension only if that file is uncontested.
- A contested extension aborts the run cleanly and re-plans. It does not queue, block or retry against a held fence.

No waiting means no cycles. The alternative, extension-with-blocking, is a lock manager and a deadlock detector, which is a week of work to support a case that happens twice a day.

On the canvas a contested node gets a hatched border and a chip reading `held by agent-a`. Fences are visible to everyone and expire when a run ends.

### 17.4 One measurement lane

The temptation is a dev server per worktree. Resist it. Three Next dev servers is 4–5GB before Electron, and worse, three builds racing on one machine produce timings that cannot be compared to each other, which defeats the point of measuring at all.

```
  agent-a edits ─┐
  agent-b edits ─┼──► measurement queue ──► one worktree at a time
  agent-c edits ─┘         │                  build → replay ×N → stats
                           │                  server reaped after
                           ▼
                     patch card, measured
```

One server alive at a time, on an otherwise idle machine, reaped when its measurement ends. Parallel editing, serialized measurement. RAM is bounded at one server no matter how many agents run, and every number in the session was produced under the same conditions.

A measurement is 1–3 minutes: 30–90s build plus 15–20 replays. That is long enough that the wait needs a UI, which is what §17.5 is.

### 17.5 The queue strip

A strip under the canvas, one row per agent.

```
┌────────────────────────────────────────────────────────────┐
│ a  getUserStats        edited · queued 2nd      claims −87% │
│ b  StatsGrid           measuring ⟳  run 12/20               │
│ c  lib/api/fetch.ts    editing                              │
└────────────────────────────────────────────────────────────┘
```

Three states, no more: editing, queued, measuring. A finished run becomes a patch card carrying its claimed delta and, after landing, its measured one.

### 17.6 Landing

A patch, not a merge. A person picks the order, one at a time, and after each land the queue rebuilds, replays and re-measures against the new baseline.

Significance per §11.2, with one correction: Mann-Whitney across 40 nodes at α=0.05 lights roughly two of them by chance on every rebuild, which is the exact wolf-crying §11.2 exists to prevent. Benjamini-Hochberg over the node set, about ten lines.

A patch whose win does not survive the land says so on its card, in the plainest available words: `claimed −70% · measured −4% · not significant`. Keeping that card visible is the honest part of the feature.

### 17.7 Undo and attribution

§10.5's git-stash undo becomes per actor. A landed patch is a real commit with `Co-authored-by`. Every actor action lands in an append-only `.vibez/room.log`. One key ends every run and releases every fence.

### 17.8 What this does not need

No network. No pairing. No accounts. No presence. No relay. It runs on one laptop with the lid open and it is the most valuable of the three features.

---

## 18. The voice

### 18.1 On the desktop first

The first draft put the microphone on the iPad and immediately hit a wall: Safari grants `getUserMedia` only in a secure context, and `http://192.168.1.x` is not one, so voice-on-pad needs a certificate story before it needs a model.

Skip all of it. Hold ⌥Space at the keyboard. No pairing, no certificate, no pad, and the feature ships two phases earlier. When the pad exists it forwards a button press and the audio still comes from the machine three feet away.

### 18.2 The problem is easier than dictation

Whisper Flow transcribes arbitrary prose into a text field. This does not.

Utterances here are four words long, and the nouns are already pinned by whatever is selected on the canvas. Nobody says `getUserStats`. They select it and say *make it one query*. A transcription error on "the" costs nothing, and the error that would cost everything is the one the selection already prevented.

Design consequence: **ship with no vocabulary biasing at all, measure, and add §18.5 only if the measurement demands it.** The first draft built the biasing apparatus as though the feature depended on it. It does not.

### 18.3 Pipeline

```
mic ── 20ms frames ──► VAD (30ms hop, endpointing only)
                         │
                         ▼
                  streaming ASR, local
                     │ partials ──► ghost line in the agent panel
                     │ final on release
                     ▼
                  deterministic cleanup, ~40 rules
                     ▼
                  snap to vocabulary
                     ▼
                  intent{ utterance, scope, nodes } ──► Agent SDK
```

16kHz mono s16le. VAD endpoints inside a held press and trims leading silence. It never starts anything.

### 18.4 Model

Evaluate before committing. Week one of the phase, on a fixed set of 50 recorded utterances.

| Candidate | First partial, realistic | Notes |
|---|---|---|
| Moonshine / Parakeet, short-form streaming | 150–300ms | Built for exactly this input shape. Start here. |
| whisper.cpp base.en | ~300ms | Fast, weak on symbol names, which §18.6 fixes anyway |
| whisper.cpp large-v3-turbo | 500–1500ms | Best accuracy, too slow to feel live. Streaming chunks at 0.5–1s before it can decode. |
| hosted streaming ASR | ~150ms | Opt-in, off by default, named in the status bar |

Local by default is positioning, not only privacy. Vibez claims *measured, not described*. A tool that uploads your voice so a server can hear four words is not that tool.

### 18.5 Cleanup is rules, not a model

Roughly forty deterministic rules: strip fillers from a fixed list, collapse stuttered repeats, drop the abandoned clause before *no wait* or *actually*, normalize numbers.

No LLM cleanup pass. A model that politely rewrites *don't touch the auth code* is a catastrophe, and the agent tolerates disfluency perfectly well.

### 18.6 Snap, then bias

If the measurement in §18.4 shows symbol names being mangled, the fix is deterministic before it is probabilistic.

**Snap.** Match each transcript token against the current flow's vocabulary by phonetic distance, double-metaphone plus bounded edit distance, and correct in place. Closed vocabulary of about fifty nouns that are on the screen, so this is reliable in a way prompt conditioning is not.

**Bias, only if snap is not enough.** Whisper takes an `initial_prompt`; feed it node labels, symbol names, file basenames and fact names, refreshed per graph rev, ranked selected-first then by heat. Cap at 200 tokens because the prompt window is 224. It is soft conditioning and it can induce repetition, so it is the second tool, not the first.

### 18.7 The utterance is never the whole prompt

```ts
{
  utterance: "make it one query",
  fence: ["lib/db/queries.ts"],
  nodes: [ /* IR for fenced nodes: label, anchor, metrics, facts */ ],
  flow: "dashboard",
  measurement: "true",
  baseline: { p50: 2400 }
}
```

Four spoken words plus `n+1 · 12 duplicate queries · queries.ts:88` is unambiguous. The detectors in §9 did the hard part before anyone opened their mouth.

### 18.8 Nothing reaches disk without a tap

Every voice turn first renders one line:

```
getUserStats · batch 12 queries into 1 · 1 file
```

Click to run, click to cancel. Never a silence timeout, never an auto-confirm. Voice starts the work, a deliberate gesture commits it. This is the difference between usable and frightening.

### 18.9 Budget and failure

| Stage | Budget |
|---|---|
| press → first partial | 300ms |
| release → final, 10s of speech | 600ms |
| final → intent dispatched | 50ms |
| any failure | a text field, prefilled with the last partial |

Never lose an utterance. Losing what someone just said is the one unforgivable failure in a voice interface.

### 18.10 Banned

Wake words. A voice that talks back. Always-on transcription. Persisted transcripts. Dictating code character by character. Reading the diff aloud.

---

## 19. The link

Only now, and only because §20 needs a second device.

### 19.1 One socket, one pairing primitive

`packages/link`: a WebSocket server in the extension host, bound to the LAN interface, advertised over mDNS as `_vibez._tcp`. A short-lived token in a QR, exchanged once for a device key in `~/.vibez/devices.db`, revocable per device from settings.

```ts
type Msg =
  | { t: 'hello';    actor: Actor; protocol: 1 }
  | { t: 'graph';    flow: FlowId; rev: number; graph: Graph }
  | { t: 'patch';    flow: FlowId; rev: number; ops: Op[] }
  | { t: 'camera';   actor: ActorId; x: number; y: number; zoom: number }
  | { t: 'cursor';   actor: ActorId; x: number; y: number }
  | { t: 'ink';      actor: ActorId; strokeId: string; pts: InkPt[]; done: boolean }
  | { t: 'select';   actor: ActorId; nodes: SemanticKey[]; origin: 'click' | 'ink' | 'region' }
  | { t: 'ptt';      actor: ActorId; down: boolean }
  | { t: 'timeline'; actor: ActorId; steps: Step[] }
  | { t: 'fence';    held: Record<ActorId, string[]> }
```

No `audio` message. The microphone stayed on the desktop, §18.1; the pad sends a button state.

### 19.2 Two rules

**Graph coordinates, never screen pixels.** A 13-inch iPad and a 27-inch monitor agree with no calibration because nothing on the wire is measured in pixels.

**Never source code.** The IR, selections, strokes and timelines. Files stay on the machine that owns them. The pad shows the graph, not your repo. That keeps payloads under 50KB, since the graph is capped at 40 nodes by design, and it is the right default if a peer ever joins.

### 19.3 No pixel streaming

Every surface renders the same bundle from the same IR. Screen sharing is blurry, breaks ink registration and makes the pad a dumb terminal instead of a device with its own camera.

---

## 20. The slate

An iPad paired to the IDE. Reframed from the first draft.

### 20.1 It is a review surface, not an input surface

Circling a node on the graph is not faster than clicking it with a mouse, and pretending otherwise is how this becomes a demo.

What the iPad actually adds is a second screen that does not compete with the editor for space, and a posture where you are looking at your running app instead of your code. You hold it, you poke at your app, you circle the part that feels wrong, and the Mac lands on the line. The circling is what you do while you are already over there, not the reason to go.

That is a smaller claim than the first draft made, and it is the one that survives contact with a mouse.

### 20.2 Hard prerequisite

The best gesture on the pad is circling a region of the running app, which needs §3.4's region-to-node mapping to reach server-side nodes. It does not today: the bridge tags DOM from the fiber tree in the browser, the spans come from the Node process, and nothing joins the two traces.

Fix in v1 Phase 3: propagate trace context into the HTML, a meta tag carrying `traceparent` that the client shim reads. Without it, circling a region can only ever select client-side nodes, and this phase has no headline.

### 20.3 Pairing

`Vibez: Pair a device` puts a QR on the canvas encoding `https://<host>/p#<token>`, 8 random bytes, 60-second TTL, single use. The desktop then asks once, with a four-digit code shown on both screens, so a QR photographed over your shoulder is not enough.

### 20.4 The pad renders its own graph

Same bundle, same IR, its own camera. Camera sync is a toggle defaulting to follow-desktop; drawing detaches it and a pill offers to re-sync. Nobody's camera is ever moved by someone else, which is §5.4's rule on a second screen.

### 20.5 Ink

`PointerEvent` with `pointerType === 'pen'`. Finger pans and zooms, pencil draws. That split is the Procreate convention and palm rejection comes free with it.

Ink renders on its own layer above React Flow at the same transform, echoed locally on the first frame, never waiting for the network. Strokes also stream to the desktop at 60Hz so the desktop shows the line being drawn, which is most of why two screens feel like one surface.

Two things to verify in week one, before anything is built on them: `getCoalescedEvents` and especially `getPredictedEvents` on current iPadOS Safari. WebKit shipped them late and predicted events may still be missing, which changes the latency story.

### 20.6 Latency, honestly

| Stage | Budget |
|---|---|
| pen sample → ink pixel | 50ms |
| stroke end → selection resolved on the pad | 30ms, local |
| selection → highlight on the desktop | 80ms over LAN |
| graph rev → repaint on the pad | 120ms |

The first draft said 16ms. Native PencilKit is around 9ms; a Safari canvas is realistically 30–50ms and there is no way around that from a web view. For a lasso that lives 300ms and then evaporates, 50ms is fine. Above 80ms it is not, and that is the only argument that justifies a native client.

Above 150ms p95 on the round trip the pad drops camera mirroring and goes fully local. A jittery mirrored camera is worse than none.

### 20.7 Four gestures

| Gesture | Recognizer | Result |
|---|---|---|
| circle | endpoints within 15% of the stroke's bounding-box diagonal | selects every node ≥60% inside the closed polygon |
| tap | pen down and up under 120ms, under 6px travel | selects the node under it |
| scribble | four or more direction reversals inside one node's box | deselects that node |
| strike | open stroke crossing exactly one wire, overlapping no node | selects that edge |

Anything else is an annotation and does nothing. Resolution happens on the pad against the local IR; the desktop receives `select`, not geometry. Ink fades over 400ms once resolved.

The load-bearing claim: ink is an input method for the fence in §4.3, not a new mechanism. The agent surface area added by the iPad is zero.

### 20.8 A circle that catches eleven nodes

One node is obvious. Eleven is a fence over half the repo, which is worse than no fence. Over six, the pad shows one line and two buttons: `6 nodes · 4 files — fence all, or just the slow one?`

### 20.9 The preview tab

The pad's preview is a second session against the same dev server, not a mirror of the desktop's iframe, so its client state is its own. That is fine, since you are circling a region rather than a moment, but label it `your session` so nobody wonders where their form input went.

### 20.10 Not on the pad

No file tree. No terminal. No editor. No full agent transcript. No sketch-to-code, no handwriting recognition, no text entry that needs precision from a finger.

---

## 21. Presence

The remainder of "watch your teammates," demoted to optional and gated on demand.

### 21.1 Gate

Build this when two people have used §17's queue together for a week and asked for it. Not before. The queue is what makes collaboration legible; cursors are what make it feel busy.

### 21.2 About a hundred lines

Nothing here is collaboratively edited, so there is no CRDT and no Yjs. Ephemeral last-write-wins state over the socket that already exists.

| Signal | Render |
|---|---|
| teammate cursor | 8px dot with a name label, their hue, 100ms interpolation |
| teammate selection | 2px ring in their hue, outside our own |
| held fence | hatched border, lock chip in the header band, from §17.3 |
| their agent editing | the §5.2 blue pulse, tinted their hue |

Not shared: file contents, terminal, keystrokes, camera rect.

### 21.3 The third color channel

§7.3 already spends two: latency on bodies and headers, type on pins and wires. Identity is a third, so it gets a strict allocation. **Actor hue appears only on rings, cursors and strokes.** Never a node body, header, pin or wire. Six fixed hues, none in the warm heat ramp, and every actor carries a name label so hue is never the only signal.

### 21.4 Attention

- At most two concurrent full timelines. Everything else is a ring pulse and a chip.
- Only your own actions move your camera. `Follow Maya` is a toggle with a persistent banner.
- A teammate's timeline plays at 60% opacity.
- §5.4's six-second cap is per actor; the canvas total is ten seconds per turn, and overflow is dropped rather than queued.

### 21.5 One host, LAN only

The repo lives on the host. Peers' agents run in host-side worktrees under host-side fences; a peer proposes a patch and only the host lands it. Joining grants reading the graph and proposing work, nothing else.

No relay, no accounts, no remote. A relay means auth, presence fan-out, reconnect and a monthly bill before there is revenue. It is the first thing in Vibez that costs money, and it waits until the free version has been worn out.

### 21.6 Banned

Voice or video chat. A chat sidebar. Photo avatars. Emoji reactions on nodes. "X is typing." Any leaderboard of who fixed more nodes.

---

## 22. Roadmap

Each phase ships something usable on its own. None of them touch the fork; all of it is `vibez-core` and `packages/link`, which is the payoff §10.1 was buying.

### Phase 7 — Actors and the queue (weeks 15–18)

- [ ] `ActorId` through `AgentEvent`, `Selection`, `Timeline`; choreographer keyed by actor
- [ ] Worktree per editing agent, `node_modules` linked, own `.next`
- [ ] Fences as no-wait allocations; contested extension aborts and re-plans
- [ ] One measurement lane, one server alive, reaped after each run
- [ ] Queue strip: editing / queued / measuring, patch cards
- [ ] Sequential landing, re-measure per land, Benjamini-Hochberg over the node set
- [ ] Per-actor undo, `Co-authored-by`, `.vibez/room.log`, kill switch

**Gate:** two agents produce two patches that both claim a win, and after landing the first, the canvas shows the second one stop mattering. If that moment is not obvious on screen without explanation, the strip is wrong.

### Phase 8 — The voice (weeks 19–20)

- [ ] ⌥Space push-to-talk on the desktop, VAD for endpointing only
- [ ] Model bake-off on 50 recorded utterances, §18.4
- [ ] Streaming partials in the agent panel
- [ ] Deterministic cleanup, ~40 rules, tested
- [ ] Intent envelope: utterance, fence, node IR, baseline
- [ ] One-line resolved instruction, explicit click to run
- [ ] Snap-to-vocabulary, and prompt biasing only if snap is not enough

**Gate:** select a node, say *why is this slow*, three times out of three, at normal speed with a fan running. No vocabulary work shipped unless the measurement demanded it.

### Phase 9 — The link (weeks 21–22)

- [ ] `packages/link`: WS server, mDNS, token pairing, device keys
- [ ] Graph on the wire, snapshot plus patches, rev numbers
- [ ] Pairing UI, device list, per-device revoke
- [ ] Trace-context propagation into the HTML, the §20.2 prerequisite

**Gate:** two windows on two machines showing the same graph, camera-synced, and clicking a region of the preview selects a server-side node.

### Phase 10 — The slate (weeks 23–25)

- [ ] Verify `getCoalescedEvents` / `getPredictedEvents` on iPadOS. First task, before anything else.
- [ ] Pad PWA: same canvas bundle, follow toggle
- [ ] Pencil ink layer, local echo, 60Hz stroke stream to the desktop
- [ ] Four gestures, resolved on the pad, 400ms fade
- [ ] Selection feeds the existing fence, no new agent surface
- [ ] Preview tab, region circling, `your session` label
- [ ] Over-six-node disambiguation
- [ ] Latency instrumented and shown in the pad's status line

**Gate:** on the third day, somebody picks up the pad without being asked to. If the honest report is that the mouse was fine, the slate is a demo and the right move is to say so and stop.

### Phase 11 — Presence (unscheduled)

Gated on §21.1. Two people, one week on the queue, and an actual request.

---

## 23. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The queue's headline moment never happens, because patches rarely interact | Fatal for §17 | Phase 7 gate. Plant two interacting problems in `examples/next-shop` and check it reproduces before building the strip. |
| Measurement lane becomes the bottleneck, agents idle waiting | High | 1–3 minutes per run and a visible queue. If depth regularly exceeds three, cap editing agents at two. |
| An agent's plan cannot predict its file set, so fences abort constantly | High | Measure abort rate in Phase 7. Over 20% means the fence granularity is wrong, probably folder-level rather than file-level. |
| ASR is slower than the table claims | Medium | Bake-off before integration, §18.4. The fallback is a smaller model, not a longer wait. |
| Voice feels like an accident waiting to happen | High | Nothing reaches disk without a click, §18.8. |
| Safari ink latency above 80ms | Medium | Measured in Phase 10 task one. The only thing that justifies a native client, and the phase is cheap to abandon. |
| Trace context never joins server and client | High | It is a Phase 9 deliverable with its own gate. §20 has no headline without it. |
| The pad is a demo | Medium | Phase 10 gate is written to kill it, and it is the last thing built, so killing it costs nothing already spent. |
| Presence turns the canvas into a disco | Low | §21.4 caps, and the feature is demand-gated anyway. |
| A third color channel collides with heat and types | Medium | Hue confined to rings, cursors and strokes, §21.3. |
| These features grow the fork diff | Low | They do not touch the fork. |

---

## 24. Definition of done

**The queue.** Three agents work at once on one laptop. Nothing races, nothing conflicts, and the fan does not come on. Two patches both claim a win, and after landing the first, the second says `claimed −70% · measured −4% · not significant` on its own card without anyone asking.

**The voice.** You select a node, hold a key, say four words, read one line, and click once. The number drops. You never opened the agent panel to type.

**The slate.** You are sitting back with your app on the iPad. Something looks slow. You circle it with the pencil and the Mac, across the room, has already opened the file. You did not touch the keyboard, and on the third day you reached for the pad on your own.
