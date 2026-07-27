#!/usr/bin/env node
// docs/demo/curate.mjs — DEMO DATA, not engine code.
//
// The public demo has to be forma applied to a repository that is not forma (docs/SCOPE.md §1),
// and the only way a stakeholder-grade board comes out of 53 flat Go packages is a human deciding
// which of them belong together. That decision cannot be derived, so it lives here, by hand, and
// it is deliberately the ONE place in this repository that names another project's packages.
// CONTRIBUTING's rule — nothing may hardcode one project's node ids, dirs or stack — binds lib/
// and bin/. This file is the curated input a user would write for their own repo, checked in so
// the demo is reproducible.
//
// Regenerate:
//   node bin/forma.mjs init --repo <haben> --out /tmp/flat.json --force
//   node docs/demo/curate.mjs /tmp/flat.json docs/demo/c4-topology.json
//   node bin/forma.mjs gen --repo <haben> --topology docs/demo/c4-topology.json --out docs/demo/c4-model.json
//   node scripts/presentable.mjs docs/demo/c4-model.json     # must exit 0
//   node bin/forma.mjs check --repo <haben> --model docs/demo/c4-model.json --topology docs/demo/c4-topology.json
// curate.mjs — hand curation of the haben topology, as a script so it is reproducible.
// Groups the 53 Go packages into 6 domains (level=component, parent=<domain>, kind STAYS
// "container" or the Go adapter drops the import edges), names the context actors, and writes a
// description for every package the feature matrix does not already describe.
//
//   node curate.mjs topo-flat.json topo-curated.json
import { readFileSync, writeFileSync } from 'node:fs'

const [, , IN, OUT] = process.argv
const t = JSON.parse(readFileSync(IN, 'utf-8'))

// 6 domains, by what the packages do for the family — not by directory.
const DOMAINS = {
  denaro: {
    name: 'Denaro e patrimonio',
    description: 'Conti, strumenti, posizioni e mercato: quanto vale il patrimonio oggi e come si muove.',
    pkgs: ['internal/account', 'internal/allocation', 'internal/backtest', 'internal/benchmark', 'internal/bondladder',
      'internal/cedole', 'internal/consolidation', 'internal/contribution', 'internal/frontier', 'internal/instrument',
      'internal/market', 'internal/pac', 'internal/portfoliohistory', 'internal/position'],
  },
  fisco: {
    name: 'Fisco',
    description: 'Plusvalenze, minusvalenze e dichiarazione: cosa deve al fisco la famiglia e quando.',
    pkgs: ['internal/fisco', 'internal/taxanalysis', 'internal/taxloss', 'internal/taxreport'],
  },
  famiglia: {
    name: 'Famiglia e obiettivi',
    description: 'Budget, paghette, traguardi dei figli e consigli: il denaro visto come progetto di famiglia.',
    pkgs: ['internal/advisor', 'internal/allowance', 'internal/budget', 'internal/challenge', 'internal/decision',
      'internal/diary', 'internal/familygraph', 'internal/income', 'internal/insight', 'internal/kidgoal',
      'internal/milestone', 'internal/runway'],
  },
  archivio: {
    name: 'Archivio e documenti',
    description: 'Estratti conto in entrata, esportazioni in uscita e la cassaforte dove i documenti restano.',
    pkgs: ['internal/capsule', 'internal/cometa', 'internal/datematch', 'internal/export', 'internal/imports',
      'internal/store', 'internal/vault', 'internal/vaultmanager', 'migrations'],
  },
  accesso: {
    name: 'Accesso e identita',
    description: 'Chi entra, con quale dispositivo e con quali avvisi: sessioni, chiavi di accesso e profilo.',
    // `pairing` is device pairing, not family pairing: session and webauthnauth are its only two
    // importers, and it sat in "Famiglia" purely because the name reads that way.
    pkgs: ['internal/notify', 'internal/pairing', 'internal/profile', 'internal/session', 'internal/webauthnauth'],
  },
  piattaforma: {
    name: 'Piattaforma',
    description: 'Il servizio che espone tutto il resto: eseguibili, API HTTP, interfaccia web e lavori in background.',
    pkgs: ['cmd/haben', 'cmd/haben-ocr', 'internal/health', 'internal/server', 'internal/spine',
      'internal/testsupport', 'internal/web', 'internal/worker', 'scripts'],
  },
}

// Prose for the packages the feature matrix never names. Predicate 3 exists because "6 source
// files." is what the code counted, not what the part does.
const PROSE = {
  'cmd/haben': 'Avvia il server dell applicazione con la configurazione della macchina su cui gira.',
  'cmd/haben-ocr': 'Legge i PDF degli estratti conto e ne estrae le righe di movimento.',
  'internal/advisor': 'Suggerisce la mossa successiva a partire da quello che il portafoglio mostra.',
  'internal/allowance': 'Gestisce la paghetta dei figli: quanto, quando e quanto ne resta.',
  'internal/backtest': 'Rigioca una strategia sui prezzi passati per vedere come sarebbe andata.',
  'internal/benchmark': 'Confronta il rendimento del portafoglio con gli indici di riferimento.',
  'internal/budget': 'Tiene il bilancio mensile della famiglia, entrate contro uscite.',
  'internal/capsule': 'Congela una fotografia dei dati per poterla rileggere identica piu avanti.',
  'internal/challenge': 'Le sfide di risparmio proposte ai ragazzi e il loro stato.',
  'internal/consolidation': 'Somma i conti di tutti i membri in un unico patrimonio di famiglia.',
  'internal/datematch': 'Riconcilia le date dei movimenti quando le fonti non concordano.',
  'internal/familygraph': 'Chi e chi in famiglia e chi puo vedere i conti di chi.',
  'internal/fisco': 'Le regole fiscali italiane applicate ai movimenti del portafoglio.',
  'internal/frontier': 'Calcola la frontiera efficiente per confrontare rischio e rendimento attesi.',
  'internal/health': 'Risponde alle sonde di stato del servizio per il monitoraggio.',
  'internal/income': 'Registra le entrate ricorrenti della famiglia e la loro cadenza.',
  'internal/kidgoal': 'Gli obiettivi di risparmio dei figli e i progressi verso il traguardo.',
  'internal/portfoliohistory': 'Conserva il valore del portafoglio giorno per giorno.',
  'internal/server': 'Espone le API HTTP e instrada ogni richiesta al dominio giusto.',
  'internal/session': 'Apre, rinnova e chiude le sessioni di chi ha effettuato l accesso.',
  'internal/spine': 'Il cablaggio comune: configurazione, log e avvio dei servizi condivisi.',
  'internal/store': 'Il database: legge e scrive ogni dato persistente dell applicazione.',
  'internal/testsupport': 'Impalcature condivise dai test, mai in esecuzione in produzione.',
  'internal/vault': 'La cassaforte cifrata dove i documenti sensibili restano a riposo.',
  'internal/vaultmanager': 'Governa chiavi e rotazione della cassaforte.',
  'internal/webauthnauth': 'Accesso senza password con le chiavi del dispositivo (WebAuthn).',
  migrations: 'Le migrazioni che portano il database da una versione allo schema successivo.',
  scripts: 'Utilita a riga di comando per manutenzione e operazioni una tantum.',
}

// Predicate 1: slide one of any architecture talk is *who touches this*.
const ACTORS = [
  { id: 'famiglia_utente', level: 'context', kind: 'person', name: 'Famiglia', tech: 'Browser',
    description: 'I due genitori e i figli: consultano il patrimonio, registrano le spese e seguono gli obiettivi.' },
  { id: 'banca_broker', level: 'context', kind: 'external', name: 'Banca e broker', tech: 'CSV / PDF',
    description: 'Le fonti degli estratti conto e dei prezzi: da qui arrivano i movimenti che il sistema riconcilia.' },
  { id: 'agenzia_entrate', level: 'context', kind: 'external', name: 'Agenzia delle Entrate', tech: 'Dichiarazione',
    description: 'Il destinatario della dichiarazione: il sistema prepara i quadri, non li trasmette.' },
]
const ACTOR_EDGES = [
  { from: 'famiglia_utente', to: 'haben', label: 'consulta e registra', kind: 'runtime', estatus: 'active' },
  { from: 'banca_broker', to: 'haben', label: 'estratti conto e prezzi', kind: 'runtime', estatus: 'active' },
  { from: 'haben', to: 'agenzia_entrate', label: 'quadri della dichiarazione', kind: 'runtime', estatus: 'active' },
]

// The demo also exercises Forma's optional future-architecture timeline. `CONFINE.md` is haben's
// current product boundary: five open issues move it from author-operated software to a maintained
// family product. Only architectural effects become patches. The last issue is operational
// custody, so its empty patch deliberately demonstrates "nessun cambio architetturale".
const TIMELINE = {
  source: 'docs/steering/CONFINE.md',
  checkpoints: [
    {
      id: 'lan',
      label: 'LAN · #570',
      badge: '1 issue · ingresso durevole',
      patch: {
        nodes: {
          add: [{
            node: {
              id: 'lan_ingress', level: 'component', parent: 'piattaforma', kind: 'component',
              name: 'Ingresso LAN durevole', tech: 'Caddy / Docker Compose',
              description: 'Espone haben sulla LAN attraverso il proxy condiviso e sopravvive ai riavvii del NAS.',
              status: 'planned', status2: 'next', issues: ['#570'],
            },
            change: 'Aggiunge l ingresso LAN durevole richiesto dal confine di consegna.',
          }],
          update: [{
            id: 'haben',
            set: {
              current: 'Raggiungibile dalla famiglia sulla LAN attraverso un ingresso durevole sul NAS.',
              status2: 'next', issues: ['#570'],
            },
            change: 'Porta il sistema al checkpoint in cui la sessione familiare puo iniziare senza terminale.',
          }],
        },
        edges: {
          add: [{
            edge: {
              from: 'lan_ingress', to: 'cmd_haben', label: 'inoltra richieste', level: 'component',
              kind: 'runtime', status: 'planned', estatus: 'to-build',
            },
            change: 'Collega il proxy LAN al processo haben.',
          }],
        },
      },
    },
    {
      id: 'casa',
      label: 'CASA · #358',
      badge: '1 issue · tenant condiviso',
      patch: {
        nodes: {
          add: [{
            node: {
              id: 'tenant_casa', level: 'component', parent: 'accesso', kind: 'component',
              name: 'Tenant Casa', tech: 'Authelia / SQLite silo',
              description: 'Consente a Luca e Veronica di usare il silo condiviso Casa con identita individuali.',
              status: 'planned', status2: 'next', issues: ['#358'],
            },
            change: 'Aggiunge il tenant condiviso Casa al perimetro di accesso.',
          }],
          update: [{
            id: 'famiglia_utente',
            set: {
              current: 'Luca e Veronica accedono con identita individuali al tenant condiviso Casa.',
              status2: 'next', issues: ['#358'],
            },
            change: 'Rende visibile nel contesto il passaggio da autore singolo a uso familiare.',
          }],
        },
        edges: {
          add: [{
            edge: {
              from: 'internal_session', to: 'tenant_casa', label: 'autorizza membri', level: 'component',
              kind: 'runtime', status: 'planned', estatus: 'to-build',
            },
            change: 'Collega la sessione autenticata alla membership del tenant Casa.',
          }],
        },
      },
    },
    {
      id: 'offline',
      label: 'OFFLINE · #499',
      badge: '1 issue · exactly-once',
      patch: {
        nodes: {
          add: [{
            node: {
              id: 'offline_outbox', level: 'component', parent: 'famiglia', kind: 'component',
              name: 'Outbox spese offline', tech: 'PWA / IndexedDB',
              description: 'Accoda una spesa senza rete e la sincronizza una sola volta quando il NAS torna raggiungibile.',
              status: 'planned', status2: 'next', issues: ['#499'],
            },
            change: 'Aggiunge l outbox offline richiesta dalla sessione di confine.',
          }],
          update: [{
            id: 'haben',
            set: {
              current: 'Una spesa catturata offline viene consegnata una sola volta e resta disponibile il giorno dopo.',
              status2: 'next', issues: ['#499'],
            },
            change: 'Porta la promessa exactly-once della cattura mobile nel checkpoint di sistema.',
          }],
        },
        edges: {
          add: [{
            edge: {
              from: 'offline_outbox', to: 'internal_budget', label: 'sincronizza una volta', level: 'component',
              kind: 'runtime', status: 'planned', estatus: 'to-build',
            },
            change: 'Collega la cattura offline al dominio budget con consegna idempotente.',
          }],
        },
      },
    },
    {
      id: 'numeri',
      label: 'NUMERI · #505',
      badge: '1 issue · patrimonio corretto',
      patch: {
        nodes: {
          update: [
            {
              id: 'internal_account',
              set: {
                current: 'Le carte di credito non contribuiscono agli attivi del patrimonio netto.',
                status2: 'next', issues: ['#505'],
              },
              change: 'Rende esplicita nel dominio account la regola patrimoniale del confine.',
            },
            {
              id: 'haben',
              set: {
                current: 'I numeri mostrati alla famiglia escludono le carte di credito dagli attivi.',
                status2: 'next', issues: ['#505'],
              },
              change: 'Rende visibile nel contesto il checkpoint di correttezza patrimoniale.',
            },
          ],
        },
      },
    },
    {
      id: 'maintained',
      label: 'MANTENUTO · #560',
      badge: '1 issue · custodia operativa',
    },
  ],
}

// `forma init` now seeds two TODO placeholder actors (#33) and their edges. This curation names
// the real ones, so the placeholders are dropped rather than grouped — they are context, not
// packages, and demanding a domain for them is what made this script exit 1 the first time.
const isPlaceholder = (n) => /^TODO:/.test(String(n.name))
const dropped = new Set(t.nodes.filter(isPlaceholder).map((n) => n.id))
t.nodes = t.nodes.filter((n) => !dropped.has(n.id))
t.edges = (t.edges || []).filter((e) => !dropped.has(e.from) && !dropped.has(e.to))
const byName = new Map(t.nodes.map((n) => [n.name, n]))
const domainOf = new Map()
for (const [id, d] of Object.entries(DOMAINS)) for (const p of d.pkgs) domainOf.set(p, id)

const missing = [...byName.keys()].filter((n) => n !== 'haben' && !domainOf.has(n))
if (missing.length) { console.error('packages with no domain: ' + missing.join(', ')); process.exit(1) }

// The whole trick of the curation: the package keeps kind:"container" (the Go adapter derives
// import edges only from container-kind nodes carrying glob evidence) and moves only level+parent.
for (const n of t.nodes) {
  if (n.name === 'haben') continue
  n.level = 'component'
  n.parent = domainOf.get(n.name)
  if (PROSE[n.name]) n.description = PROSE[n.name]
}
t.nodes.push(...Object.entries(DOMAINS).map(([id, d]) => ({
  id, level: 'container', kind: 'container', parent: 'haben', name: d.name, tech: 'Go', description: d.description,
})), ...ACTORS)
t.meta = { ...(t.meta || {}), title: 'haben · demo pubblica di forma' }
t.timeline = TIMELINE
t.nodes[0].description = 'Il patrimonio della famiglia in un posto solo: conti, obiettivi, fisco e documenti.'
t.edges = [...(t.edges || []), ...ACTOR_EDGES]

writeFileSync(OUT, JSON.stringify(t, null, 2) + '\n')
console.log(`wrote ${OUT}: ${Object.keys(DOMAINS).length} domains, ${ACTORS.length} actors, ${t.nodes.length} nodes, ${TIMELINE.checkpoints.length} checkpoints`)
