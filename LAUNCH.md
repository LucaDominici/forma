# Forma — abbellimento repo + promozione (playbook)

Gran parte dell'"abbellimento" è già nel repo (README con badge+GIF, landing Pages, logo/favicon,
`GITHUB_ABOUT.md` con descrizione+12 topics, community files). Il prompt full-send applica
About/topics/Pages via API. Restano poche cose **manuali** (5 minuti) + la **promozione**.

## 1. Rifiniture repo (manuali, dopo il publish)

- [ ] **Social preview**: carica `forma-social-preview.png` in Settings → General → *Social preview*.
      (È l'immagine che appare quando condividi il link su X/LinkedIn/Slack — non si mette da API.)
- [ ] **About**: descrizione + topics + website = la Pages URL. (Se il prompt non li ha messi via API,
      copiali da `GITHUB_ABOUT.md`.)
- [ ] **Pin** il repo sul tuo profilo GitHub (tab del profilo → Customize your pins).
- [ ] **Discussions** ON (Settings → Features) — dà un posto alle domande, segnale di progetto vivo.
- [ ] **Release v0.1.0**: `gh release create v0.1.0 --title "Forma v0.1.0" --notes-from-tag`
      (o incolla la sezione dal CHANGELOG). Le release fanno sembrare il repo curato.
- [ ] Verifica che la **GIF** parta nel README e che il **live demo** (Pages) apra l'explorer.

## 2. Regole d'oro della promozione (valgono per tutti i canali)

- La **GIF del gate (rosso→verde)** è l'eroe ovunque. Guida col *gate*, non col viewer.
- **Scaglionato, mai tutto insieme.** Un canale, aspetti, il successivo.
- **Onestà sui limiti** (archi euristici, pre-1.0) → costruisce fiducia, disinnesca i critici.
- **Rispondi a TUTTI i commenti**, veloce, a mano. Niente frasi da LLM.
- Link al **repo** (non a una landing con signup). Nessun muro.

## 3. Sequenza consigliata

**Giorno 0 — build-in-public su X** (tuo profilo). Thread pronto sotto.
**Giorno +1/2 — dev.to** (`#showdev`). Post-tutorial breve col GIF.
**Giorno +3 — Product Hunt** (lancia mar o mer, 00:01 PT). Tagline sotto.
**Giorno +4/5 — Show HN**. Titolo+testo sotto. (Mar–gio mattina US.)
**Giorno +6 — Reddit**, uno alla volta: prima r/programming, poi r/devops. Copy su misura.

---

## Copy pronto

### X / Twitter (thread)
1/ Your architecture diagram was correct the day you drew it — and wrong ever since.
Forma generates an interactive C4 explorer **from your code** and **fails your CI** when the diagram
drifts. Stack-agnostic, zero-dependency, no LLM. 🧵 [allega la GIF]

2/ `npx forma-arch try` points at any repo and opens a live explorer of *your* architecture in ~10s.
It writes nothing to your tree. [screenshot/gif del viewer]

3/ The wedge is the gate: `forma check` re-derives the structure from `src/` and exits non-zero when
the model ≠ the code. Deterministic, CI-reproducible. Drift fails the build instead of rotting in a wiki.

4/ Open source, Apache-2.0. Repo + live demo 👉 <REPO_URL>
Feedback benvenuto, soprattutto su repo grandi/poliglotti.

### Show HN
**Titolo:** `Show HN: Forma – fail your CI when the architecture diagram no longer matches the code`

**Testo:** I kept watching architecture docs rot the day after they were drawn. Forma walks your
source for the real C4 structure, renders an interactive explorer, and — the point — a deterministic
`forma check` fails the build when the model drifts from the code (no LLM, reproducible).
`npx forma-arch try` opens a live explorer of your own repo in a few seconds, writing nothing.
Stack-agnostic and zero runtime dependencies. Honest limits: container edges are heuristic
cross-references (not a full import graph), and it's pre-1.0. Repo + live demo: <REPO_URL>. Happy to
answer anything.

### dev.to (#showdev, #opensource)
**Titolo:** `I built a CI check that fails when your architecture diagram lies`
Struttura: (1) il problema — diagrammi che marciscono; (2) la GIF del gate; (3) come funziona
(un `c4-model.json` → viewer + doc + gate, deterministico); (4) `npx forma-arch try` in 3 righe;
(5) scope onesto; (6) call for feedback + link repo.

### Product Hunt
**Tagline:** `Present your architecture instead of slides — and gate it in CI.`
First comment: la stessa storia dello Show HN, + la GIF, + "founder here, AMA".

### Reddit r/programming (poi r/devops)
**Titolo:** `Forma: a deterministic gate that fails your build when your architecture diagram drifts from the code`
Testo: 3 righe + GIF + link repo. Su r/devops taglia sul lato CI/PR-comment.

---

## Nota strategica
Il repo pubblico OSS è la base; il livello successivo del prodotto (scorecard di alignment su N repo
= "FleetView") è il "next" — vedi `studi/STUDIO_DRAFT_fleetview`. Prima fai amare il tool per-repo,
poi la flotta.
