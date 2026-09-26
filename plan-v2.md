# Vibez v2 — three features

Continues `plan.md`. Sections 16–22.

None of this makes sense until §15 is real. An iPad that circles a graph nobody trusts is a toy, and a room full of agents editing a codebase nobody can see is worse than one agent. Ship v1, watch someone use it, then start here.

One thing changes in the framing. §1 says "not an iPad tool." Still true. The iPad in §17 is a pointing surface for the Mac, not a second copy of Vibez.

---

## 16. The spine

The three features look unrelated and are not. Each one needs the same three things, and building them three times is how this project dies.

### 16.1 Actors

Everything in v1 has exactly one implicit actor: you. Selection is *the* selection. `choreograph()` takes one event stream. The fence belongs to nobody because there is nobody else.

Retrofit an actor dimension before anything else is built on top:

```ts
type ActorId = string        // 'local' | 'pad:<deviceId>' | 'agent:<runId>' | 'peer:<userId>'

interface Actor {
  id: ActorId
  kind: 'human' | 'pad' | 'agent'
  name: string
  hue: number                // ring and cursor only, §19.6
}

interface AgentEvent { /* ...existing... */ actor: ActorId }
interface Selection { nodes: SemanticKey[]; actor: ActorId; at: number }
interface Timeline  { steps: Step[]; actor: ActorId }
```

Doing this at the end means touching every reducer twice. Doing it first costs a day.

### 16.2 One link, three features

`packages/link`: a WebSocket server in the extension host, bound to the LAN interface, advertised over mDNS as `_vibez._tcp`. One versioned message union, shared by the pad, the microphone and the room.

```ts
type Msg =
  | { t: 'hello';   actor: Actor; protocol: 1 }
  | { t: 'graph';   flow: FlowId; rev: number; graph: Graph }
  | { t: 'patch';   flow: FlowId; rev: number; ops: Op[] }
  | { t: 'camera';  actor: ActorId; x: number; y: number; zoom: number }
  | { t: 'cursor';  actor: ActorId; x: number; y: number }
  | { t: 'ink';     actor: ActorId; strokeId: string; pts: InkPt[]; done: boolean }
  | { t: 'select';  actor: ActorId; nodes: SemanticKey[]; origin: 'click' | 'ink' | 'region' }
  | { t: 'audio';   actor: ActorId; seq: number; pcm: ArrayBuffer }
  | { t: 'asr';     actor: ActorId; text: string; final: boolean }
  | { t: 'intent';  actor: ActorId; utterance: string; scope: SemanticKey[] }
  | { t: 'timeline';actor: ActorId; steps: Step[] }
  | { t: 'fence';   held: Record<ActorId, string[]> }
```

Two rules on this wire, both load-bearing.

**Graph coordinates, never screen pixels.** A 13-inch iPad and a 27-inch monitor agree with no calibration because nothing on the wire is measured in pixels.

**Never source code.** The link carries the IR, selections, strokes, audio and timelines. Files stay on the machine that owns them. The pad shows the graph, not your repo. A remote teammate sees nodes and numbers, not your buffers. That is a privacy story, and it also keeps every payload under 50KB because the graph is capped at 40 nodes by design.

### 16.3 Send the IR, not the screen

No pixel streaming anywhere in this document. Every surface renders the same React Flow bundle from the same IR. Screen sharing is blurry, breaks ink registration, burns bandwidth, and makes the pad a dumb terminal instead of a device with its own camera.

### 16.4 One pairing primitive

A short-lived token in a QR or an invite link, exchanged once for a long-lived device key in `~/.vibez/devices.db`, revocable from a list in settings. The pad uses it, the teammate uses it, a future CLI would use it. Written once.

### 16.5 The secure-context problem

This decides whether voice can live on the iPad at all, so it belongs in the spine rather than in §18. Safari grants `getUserMedia` only in a secure context, and `http://192.168.1.x` is not one.

| Option | Cost | Verdict |
|---|---|---|
| Self-signed cert, trust profile installed on the iPad | six-step install, once per device | works, ugly, keep as an escape hatch |
| Real cert for a wildcard host whose DNS points at the LAN IP | a domain, a DNS record per device, renewals | correct long term, real infrastructure |
| Ask the user to install a VPN mesh | they install another product first | cut |
| Capture audio on the desktop; the pad only holds the button | free | **first cut** |

Ship the desktop-mic fallback. You are holding an iPad three feet from a laptop; the laptop's microphone is fine. Revisit the certificate only if someone actually wants to walk away from the desk.

### 16.6 Web, not native

The pad client is a PWA served by the extension host and added to the home screen. No App Store, no TestFlight, no second language, and the canvas bundle is already written. PencilKit would give better ink prediction, but the stroke here lives 400ms and then evaporates, so it does not matter. Go native only if §17's gate fails on latency and nothing else.

---

## 17. The slate

An iPad paired to the IDE. You circle things with a pencil. Circling is how you tell the agent where to work.

### 17.1 What it is not

No file tree. No terminal. No editor. No full agent transcript. No sketch-to-code, no handwriting recognition, no text entry that needs precision from a finger. The Mac keeps the code. The pad points at it.

### 17.2 Pairing

`Vibez: Pair a device` puts a QR on the canvas. It encodes `https://<host>/p#<token>`, token is 8 random bytes, 60-second TTL, single use. The pad opens it, upgrades to the WS, and trades the token for a device key.

The desktop then asks once: *Pranav's iPad wants to pair*, with a four-digit code shown on both screens. A QR photographed over your shoulder is not enough. Paired devices are listed in settings and revocable individually.

### 17.3 The pad renders its own graph

Same bundle, same IR, its own camera. Camera sync is a toggle, defaulting to follow-desktop. Drawing detaches the follow, and a pill offers to re-sync. Nobody's camera is ever moved by someone else without a gesture, which is §5.4's rule extended to a second screen.

### 17.4 Ink

`PointerEvent` with `pointerType === 'pen'`. `getCoalescedEvents()` for the full sample stream, `getPredictedEvents()` to hide latency. Finger pans and zooms, pencil draws — the Procreate split, with no mode toggle and free palm rejection.

Ink renders on its own canvas layer above React Flow at the same transform. It is echoed locally on the first frame and never waits for the network. Strokes also stream to the desktop at 60Hz so the desktop canvas shows the line being drawn, which is most of why the two screens feel like one surface.

### 17.5 Strokes resolve into selections

Four gestures. Not five.

| Gesture | Recognizer | Result |
|---|---|---|
| circle | endpoints within 15% of the stroke's bounding-box diagonal | selects every node ≥60% inside the closed polygon |
| tap | pen down and up under 120ms, under 6px travel | selects the node under it |
| scribble | four or more direction reversals inside one node's box | deselects that node |
| strike | open stroke crossing exactly one wire, overlapping no node | selects that edge |

Anything else is an annotation and does nothing.

Resolution happens on the pad, instantly, against the local IR. The desktop receives `select`, not geometry. The ink fades over 400ms once resolved.

This is the load-bearing claim of the whole feature: **ink is an input method for the scope fence in §4.3, not a new mechanism.** The agent surface area added by the iPad is zero. If it turns out to be more than zero, something has gone wrong.

### 17.6 A circle that catches eleven nodes

One node is obvious. Eleven is a fence over half the repo, which is worse than no fence.

Over six nodes, the pad shows one line and two buttons: `6 nodes · 4 files — fence all, or just the slow one?` Never silently fence a third of the codebase because a pencil stroke was generous.

### 17.7 Circle the app, not the graph

Second tab on the pad: the preview. §3.4 already tags DOM regions with `data-vibez-node`, and data nodes already inherit the region of the ancestor that awaited them. So circling the table in the running app fences `getUserStats`, not `StatsGrid`.

This is the demo. Circle the part of your app that feels slow, say why is this slow, and land on the line.

One honesty note: the pad's preview is a second session against the same dev server, not a mirror of the desktop's iframe. Its client state is its own. That is fine — you are circling a region, not a moment — but label it `your session` so nobody is confused about why their form input is not there.

### 17.8 Latency budget

| Stage | Budget |
|---|---|
| pen sample → ink pixel on the pad | one frame, under 16ms, local, never networked |
| stroke end → selection resolved on the pad | under 30ms, local |
| selection → highlight on the desktop | under 80ms over LAN |
| graph rev → repaint on the pad | under 120ms |

Above 150ms p95 on the round trip, the pad drops camera mirroring and goes fully local. A jittery mirrored camera is worse than no mirroring.

---

## 18. The voice

You are holding an iPad with a pencil in one hand. There is no keyboard. Speech is the only fast way to say what you want, which makes it a necessity here rather than a novelty.

### 18.1 Ours is an easier problem than dictation

Whisper Flow transcribes arbitrary prose into a text field. We do not need that. The circle already pinned the nouns; the mouth only has to supply a verb.

Real utterances are four words long: *why is this slow*, *make it one query*, *undo that*, *is this cached*. A transcription error on "the" costs nothing. A transcription error on `getUserStats` costs everything — and §18.4 is how that one is fixed.

### 18.2 Pipeline

```
pad mic ── 20ms frames ──► link ──► VAD (30ms hop)
                                      │ speech
                                      ▼
                            streaming ASR, local
                               │ partials every 300ms  ──► ghost line, pad + agent panel
                               │ final on endpoint
                               ▼
                            deterministic cleanup
                               ▼
                            intent{ utterance, scope, nodes } ──► Agent SDK
```

16kHz mono s16le, 20ms frames, raw PCM at 32KB/s. Opus only if this ever leaves the LAN.

### 18.3 Model

| Option | Where | First partial | Notes |
|---|---|---|---|
| whisper.cpp large-v3-turbo, Metal | local | ~250ms on Apple silicon | default |
| whisper.cpp base.en | local | ~90ms | fallback where there is no GPU worth using |
| hosted streaming ASR | cloud | ~150ms | opt-in, off by default, named in the status bar |

Local by default is positioning, not only privacy. Vibez's whole claim is *measured, not described*. A tool that uploads your voice so a server can hear four words is not that tool.

### 18.4 Bias the decoder with the graph

This is the part nobody building generic dictation can copy. Whisper accepts an `initial_prompt`; feed it the flow's vocabulary before every utterance — node labels, symbol names, file basenames, fact names, and a short verb list.

`getUserStats` then decodes as one symbol instead of "get user stats". `p95` stays `p95`. `queries.ts` does not become "queries dot TS".

Refresh the bias set on every graph rev. Whisper's prompt window is 224 tokens, so cap at 200 and rank: selected nodes first, then heat, then recency. We know the fifty nouns the user might say, because they are on the screen in front of them.

### 18.5 Push to talk, never an open microphone

Hold the thumb bar in the bottom-left of the pad, where the non-drawing hand already rests. On the desktop, hold ⌥Space. Release ends the utterance.

No wake word. No voice-activated start. VAD is used only for endpointing inside a held press and for trimming leading silence. iPadOS shows its own microphone indicator; we show one too, so the state is never ambiguous.

### 18.6 Cleanup is rules, not a model

Roughly forty deterministic rules: strip fillers from a fixed list, collapse stuttered repeats, drop the abandoned clause before *no wait* or *actually*, normalize numbers.

No LLM cleanup pass. A model that politely rewrites *don't touch the auth code* is a catastrophe, and the agent tolerates disfluency perfectly well anyway.

### 18.7 The utterance is never the whole prompt

What actually reaches the Agent SDK:

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

Four spoken words plus `n+1 · 12 duplicate queries · queries.ts:88` is an unambiguous instruction. The detectors in §9 did the hard part before anyone opened their mouth.

### 18.8 Nothing writes to disk without a tap

Every voice-initiated turn first renders one line on both screens:

```
getUserStats · batch 12 queries into 1 · 1 file
```

Tap to run. Tap to cancel. Never a silence timeout, never an auto-confirm. Voice starts the work; a finger commits it.

### 18.9 Budget

| Stage | Budget |
|---|---|
| press → first partial | 300ms |
| release → final, 10s of speech | 600ms |
| final → intent dispatched | 50ms |
| any failure | fall back to a text field prefilled with the last partial |

Never lose an utterance. Losing what someone just said is the one unforgivable failure in a voice interface.

### 18.10 Banned

Wake words. A voice that talks back. Always-on transcription. Transcripts persisted by default. Dictating code character by character. Reading the diff aloud.

---

## 19. The room

Multiple agents working at once, and multiple people watching it happen on the same canvas.

### 19.1 These are two problems

"Several agents work in parallel" is a work-isolation problem. "I can see what my teammate is doing" is a presence problem. They share a canvas and nothing else. Building them as one feature is the standard way this goes wrong.

### 19.2 We do not build collaborative text editing

Live Share exists and is better than anything we would ship. If a team wants shared buffers they can run it alongside.

Vibez shares the graph, the fences, the agent activity and the measured numbers. Those are exactly the things Live Share does not have, and they are the reason a shared canvas is worth anything here.

### 19.3 Each agent gets a worktree

```
repo/
├── .git/
├── <your working tree>
└── .vibez/worktrees/
    ├── agent-a/          git worktree, own branch, own port
    └── agent-b/
```

Own dev server, own port, own OTLP stream tagged with the actor, own graph rev, own replay. Consequence: every agent's claim is independently measured, and two agents' numbers are comparable because the same Playwright script produced both.

The cost is real — three dev servers is what a laptop tolerates. Hard cap of three concurrent agents, the cap is visible in the UI, and idle worktree servers are reaped after five minutes.

### 19.4 The fence becomes a lock

§4.3's fence is per-turn. Promote it to a global allocation:

- An actor requests a fence, from a circle, a click, or an agent's own plan.
- The host grants it only if the file set is disjoint from every fence currently held.
- An overlap is refused with a reason drawn on the canvas: contested nodes get a hatched border and a chip reading `held by Maya's agent`.
- Fences expire when the run ends, or on a timeout, and every fence is visible to everyone in the room.

Conflict avoidance, not conflict resolution. It is boring, and it beats three agents racing in one tree.

### 19.5 Landing is sequential and re-measured

Each finished run is a patch, not a merge. A person picks the order. After each land: rebuild, replay, re-measure, Mann-Whitney against the *new* baseline.

The second patch frequently stops being a win once the first one lands. A terminal cannot show you that. The canvas can, and that is the actual argument for putting multi-agent work in this product rather than somewhere else.

### 19.6 Presence

Yjs awareness over the same link, ephemeral, never persisted. Shared: camera rect, cursor in graph coordinates, live strokes, selection, held fences, agent chips. Not shared: file contents, terminal, keystrokes.

| Signal | Render |
|---|---|
| teammate cursor | 8px dot with a name label, their hue, 100ms interpolation |
| teammate camera | a thin rect in the minimap only, never on the canvas |
| teammate selection | 2px ring in their hue, outside our own selection ring |
| held fence | hatched node border, lock chip in the header band |
| their agent editing | the §5.2 blue pulse, tinted their hue |
| their ink | live stroke in their hue, same 400ms fade |

§7.3 already spends two color channels: latency on bodies and headers, type on pins and wires. Identity is a third, so it gets a strict surface allocation — **actor hue appears only on rings, cursors and strokes.** Never on a node body, header, pin or wire. Six fixed hues, none of them in the warm heat ramp. Every actor also carries a name label, so the hue is never the only signal.

### 19.7 Attention

Several actors animating at once is unreadable.

- At most two concurrent full timelines. Everything else collapses to a ring pulse and a chip in the ribbon.
- Only your own actions move your camera. `Follow Maya` is a toggle with a persistent banner.
- A teammate's timeline plays at 60% opacity.
- §5.4's six-second cap is per actor; the canvas total is ten seconds per turn. Overflow is dropped, not queued.

### 19.8 LAN first, and the first server bill

On a LAN, a teammate scans the same QR from §17.2 and there is no infrastructure at all. That version works at a table, and it is the honest v1 of this feature.

Remote means a relay: auth, accounts, presence fan-out, reconnect, and a monthly bill before there is any revenue. Do not build it until the LAN version has survived a week of real use by a real pair.

### 19.9 Security

The room has one host, and the repo lives there.

- Peers' agents run in host-side worktrees under host-side fences. A peer never gets write access to your tree; they propose a patch, and only the host lands it.
- Joining a room grants reading the graph and proposing work. Nothing else.
- Every actor action is attributed in an append-only `.vibez/room.log`.
- One key ends every run and releases every fence.
- §10.5's git-stash undo becomes per actor. A landed patch is a real commit with `Co-authored-by`.

### 19.10 Banned

Voice or video chat. A chat sidebar — use the tool you already use. Photo avatars. Emoji reactions on nodes. "X is typing." Any leaderboard of who fixed more nodes.

---

## 20. Roadmap

Order is forced. The spine is the shared dependency. The slate is single-player and proves the transport with one device. Voice rides the same socket and introduces no new distributed state. The room introduces all of it, plus auth and money, so it goes last.

None of these three need a single line of fork diff. All of it lands in `vibez-core` and `packages/link`, which is the payoff §10.1 was buying.

### Phase 7 — The spine (weeks 15–16)

- [ ] `packages/link`: WS server, mDNS advert, token pairing, device keys
- [ ] `ActorId` through `AgentEvent`, `Selection`, `Timeline`; choreographer keyed by actor
- [ ] Graph on the wire: full snapshot plus patches, rev numbers
- [ ] Pairing UI, device list, per-device revoke

**Gate:** two windows on two machines showing the same graph, camera-synced. If the actor retrofit touches more than a dozen files, the model is wrong — fix it now, not with three features stacked on top.

### Phase 8 — The slate (weeks 17–19)

- [ ] Pad PWA: the same canvas bundle, follow toggle
- [ ] Pencil ink layer, coalesced and predicted events, local echo
- [ ] Four gestures, resolved on the pad, 400ms fade
- [ ] Selection feeds the existing fence — no new agent surface
- [ ] Pad preview tab, region circling through `data-vibez-node`
- [ ] Over-six-node disambiguation
- [ ] Latency budget instrumented, shown in the pad's status line

**Gate:** circle a node on the pad, the desktop fence appears in under 100ms, with no setup beyond the QR. If you reach for the keyboard to fix the selection, the gestures are wrong.

### Phase 9 — The voice (weeks 20–22)

- [ ] Audio frames over the link, VAD endpointing
- [ ] whisper.cpp with Metal, streaming partials
- [ ] Graph-biased prompt, refreshed per rev, capped at 200 tokens
- [ ] Deterministic cleanup, roughly forty rules, tested
- [ ] Intent envelope: utterance, fence, node IR, baseline
- [ ] One-line resolved instruction, explicit tap to run
- [ ] Desktop-mic fallback when the pad has no secure context

**Gate:** a circle plus "why is this slow" produces the right fence and the right answer three times out of three, spoken at normal speed with a fan running. And every proper noun on the canvas transcribes exactly.

### Phase 10 — The room (weeks 23–27)

- [ ] Worktree per agent, port allocation, per-actor OTLP tagging
- [ ] Fences as global locks, contested rendering, expiry
- [ ] Sequential landing, re-measure and significance after each land
- [ ] Yjs awareness, presence rendering per §19.6
- [ ] Attention caps per §19.7
- [ ] Append-only room log, kill switch, per-actor undo
- [ ] LAN only. No relay, no accounts.

**Gate:** two people and three agents in one room for an afternoon, nobody loses work, and nobody asks what is happening on their screen.

---

## 21. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Ink is a gimmick and people go back to the mouse | Fatal for §17 | Phase 8 gate. If the mouse selects one node faster, circling the *preview* is the only remaining justification. If that is weak too, cut the slate. |
| ASR mangles symbol names | High | Graph-biased prompt §18.4. Measure noun accuracy against a fixed list of 50 symbols, not WER. |
| Voice feels like an accident waiting to happen | High | Nothing reaches disk without a tap, §18.8. |
| Secure-context wall blocks the pad microphone | Medium | Desktop-mic fallback ships first; the certificate is optional work. |
| Three dev servers melt the laptop | High | Hard cap of three, visible in the UI, idle servers reaped at five minutes. |
| Parallel agent output is unmergeable | High | Disjoint fences by construction, sequential landing, re-measure after each. |
| Presence turns the canvas into a disco | Medium | §19.7 caps; two animated actors maximum. |
| A third color channel collides with heat and types | Medium | Identity hue confined to rings, cursors and strokes, §19.6. |
| The relay becomes the product, and a bill | Medium | LAN only until a real pair has used it for a week. |
| The pad grows a file tree and becomes an editor | Medium | §17.1. |
| These features grow the fork diff | Low | They do not touch the fork. All of it is `vibez-core` plus `packages/link`. |

---

## 22. Definition of done for v2

Two people at one table, one laptop, one iPad, in under five minutes:

1. Scan a QR. The graph is on the pad, with no configuration.
2. Circle the loud node with a pencil and say *why is this slow*.
3. The fence lands on one file. The answer is one line, and the canvas already showed it.
4. Say *make it one query*, tap to confirm, watch the choreography run on both screens at once.
5. The teammate, on their own machine, sees the fence, the pulse and the number drop without asking what is going on.
6. A second agent works a different node the entire time and never touches the first one's files.
7. Landing both patches re-measures. One of them turns out not to have mattered, and the canvas says so.

The part that makes it a product rather than a demo: the person holding the iPad never typed anything.
