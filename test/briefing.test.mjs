#!/usr/bin/env node
// The Control Room briefing surface: markdown rendering, locale string parity, the workflow view's
// queue and kanban, issue pills, the embedded C4 drill, and the public map's accessibility contract.
import test, { describe } from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LENSES } from "../lib/lenses.mjs";
import { makeKanbanFixture } from "./fixtures/control-room-stress/kanban.mjs";

import { HERE, run, die, readJson } from "./helpers.mjs";

describe("briefing", () => {
  // I14 on a surface that did not exist before: the briefing now RENDERS markdown out of a
  // repository's own documents, and a link target read from that prose is attacker-adjacent input.
  // Assigning it to .href unchecked makes `[read me](javascript:...)` live XSS in a document written
  // by somebody else. The renderer is lifted out of the shipped template and driven directly, the
  // same trick this suite already uses for the viewer's pure functions.
  test("briefing: markdown", async () => {
    const src = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    const inlineFn = /function inline\(target,text,program\)\{[\s\S]*?\n\}/.exec(
      src,
    );
    const elFn = /function el\(t,c,x\)\{[^\n]*\n/.exec(src);
    const markFn = /function statusMark\(v\)\{[^\n]*\n/.exec(src);
    const pillFn = /function pill\(p,n,t,endpoint\)\{[\s\S]*?\n\}/.exec(src);
    // The pill wears a health verdict, and the verdict lens owns that surface (I20): the pill reads
    // the index the lens publishes, never derived.health itself. Both halves are lifted, so this test
    // exercises the real lookup rather than a stand-in that could stay green while the pair diverged.
    const indexFn = /function indexVerdicts\(\)\{[\s\S]*?\n\}/.exec(src);
    const verdictsOfFn = /function verdictMarkOf\(program,n\)\{[^\n]*\n/.exec(src);
    if (!indexFn || !verdictsOfFn)
      die("markdown: the verdict index the pill reads is not in control-room.html");
    const mdFn = /function renderMarkdown\(src,program\)\{[\s\S]*?\n\}\n/.exec(
      src,
    );
    const mdhFn = /function mdHeading\(level\)\{[^\n]*\n/.exec(src);
    if (!inlineFn)
      die(
        "markdown: inline() not found in control-room.html — the renderer moved",
      );
    if (!elFn) die("markdown: el() not found in control-room.html");
    if (!markFn || !pillFn)
      die(
        "markdown: shared issue pill primitives not found in control-room.html",
      );
    if (!mdFn)
      die(
        "markdown: renderMarkdown() not found in control-room.html — the renderer moved",
      );
    if (!mdhFn) die("markdown: mdHeading() not found in control-room.html");
    const stub = `
      var STR = {statusOk: 'OK', statusWarn: 'Warning', statusBad: 'Bad', closed: 'Closed', stateStale: 'Stale', notAudited: 'Not audited'};
      var document = {
        createElement: function (t) { return { nodeType: 1, tagName: t.toUpperCase(), attrs: {}, children: [], className: '', textContent: '', setAttribute: function (k, v) { this.attrs[k] = v }, appendChild: function (c) { this.children.push(c); return c }, get lastChild() { return this.children[this.children.length - 1] } } },
        createTextNode: function (t) { return { nodeType: 3, text: String(t) } },
      };
      var ROOM = {programs: []}, VERDICT_MARKS = Object.create(null);
      ${indexFn[0]}
      ${verdictsOfFn[0]}
      ${elFn[0]}
      ${markFn[0]}
      ${pillFn[0]}
      ${inlineFn[0]}
      ${mdhFn[0]}
      ${mdFn[0]}
      return {inline: inline, pill: pill, renderMarkdown: renderMarkdown,
              index: function (programs) { ROOM = {programs: programs}; indexVerdicts(); }};`;
    // new Function over text lifted from a TRACKED first-party file, which is the same no-jsdom trick
    // this suite already uses to test the viewer's pure functions. The interpolated strings are our
    // own source at a reviewed commit, never input; the thing being tested is precisely that the
    // renderer refuses input.
    const lifted = new Function(stub)();
    const inline = lifted.inline;
    const anchorsFor = (md) => {
      const target = {
        children: [],
        appendChild(c) {
          this.children.push(c);
        },
      };
      inline(target, md);
      return target.children.filter((c) => c.tagName === "A");
    };
    // `//host/x` is a network-path reference — same scheme, different HOST. It is not a relative path,
    // and an allow-list that lets it through is letting a document link off-site while looking local.
    for (const hostile of [
      "[go](javascript:alert(1))",
      "[go](JaVaScRiPt:alert(1))",
      "[go](  javascript:alert(1))",
      "[go](data:text/html,<script>alert(1)</script>)",
      "[go](vbscript:msgbox)",
      "[go](//evil.example/phish)",
      "[go](\\/\\/evil.example)",
    ]) {
      const a = anchorsFor(hostile);
      if (a.length)
        die(
          `markdown: ${hostile} produced a live anchor with href ${a[0].href} — a document can inject a scheme`,
        );
    }
    for (const safe of [
      "[go](https://example.com/x)",
      "[go](./docs/PRD.md)",
      "[go](/docs/PRD.md)",
      "[go](#section)",
      "[go](mailto:a@b.c)",
    ]) {
      if (!anchorsFor(safe).length)
        die(`markdown: ${safe} should be a link and was rendered as text`);
    }
    // The rejected link is shown, not swallowed: a link that will not be followed should say so.
    const rejected = {
      children: [],
      appendChild(c) {
        this.children.push(c);
      },
    };
    inline(rejected, "[go](javascript:alert(1))");
    if (
      !rejected.children.some((c) => c.text && c.text.indexOf("javascript:") > -1)
    )
      die(
        "markdown: a refused link was dropped silently instead of being shown as text (I9)",
      );

    // A prose `#n` is an issue reference only when the programme snapshot knows it. Unknown hashes
    // remain literal repository prose; known references use the same health-aware pill as every
    // operational projection, including stale and CLOSED precedence.
    const programme = {
      id: "thing",
      ghRepo: "acme/thing",
      issuesSnapshot: {
        issues: [
          { n: 7, state: "OPEN" },
          { n: 8, state: "CLOSED" },
        ],
      },
      derived: {
        health: {
          verdicts: [
            { n: 7, verdict: "bad", why: "Anchored failure.", stale: false },
            { n: 8, verdict: "bad", why: "Superseded by closure.", stale: true },
          ],
        },
      },
    };
    lifted.index([programme]);
    const issueDoc = lifted.renderMarkdown(
      "Known #7, closed #8, unknown #99.",
      programme,
    );
    const issueAnchors = [];
    const textOf = (node) =>
      String(node.text || node.textContent || "") +
      (node.children || []).map(textOf).join("");
    (function walk(n) {
      for (const child of n.children || []) {
        if (child.tagName === "A") issueAnchors.push(child);
        walk(child);
      }
    })(issueDoc);
    if (
      issueAnchors.map((a) => a.href).join() !==
      "https://github.com/acme/thing/issues/7,https://github.com/acme/thing/issues/8"
    )
      die(
        "markdown: known issue references did not become exactly two pills: " +
          issueAnchors.map((a) => a.href),
      );
    if (!textOf(issueDoc).includes("#99"))
      die(
        "markdown: an unknown issue reference was swallowed instead of staying literal",
      );
    const badPill = issueAnchors[0],
      closedPill = issueAnchors[1];
    if (
      badPill.attrs["data-tip"] !== "Anchored failure." ||
      !/Bad/.test(badPill.attrs["aria-label"])
    )
      die("room-pill: a current health verdict lost its anchored reason or word");
    if (
      !/\bclosed\b/.test(closedPill.className) ||
      closedPill.attrs["data-tip"] !== "Closed" ||
      !/Closed/.test(closedPill.attrs["aria-label"])
    )
      die("room-pill: CLOSED did not override an older stale health verdict");
    // A foreign-repo endpoint carries no verdict of OURS. Without the guard the briefing stamps our
    // verdict and our reason onto another repository's issue number — a confident false claim about a
    // repository it has never audited, which is the whole class the pill projection exists to refuse.
    const foreign = lifted.pill(programme, 7, null, { repo: "other/repo", number: 7, state: "OPEN" });
    if (foreign.attrs["data-tip"] !== "Not audited" || /Anchored failure/.test(foreign.attrs["aria-label"] || ""))
      die("room-pill: a cross-repo endpoint was stamped with this programme's verdict");
    if (!/other\/repo/.test(foreign.attrs.href || foreign.href || ""))
      die("room-pill: a cross-repo endpoint does not link to its own repository");

    // Re-index, because the pill no longer re-reads the overlay: the verdict lens decides the mark
    // once and the pill draws it. Mutating the overlay without re-indexing is exactly the state the
    // projection makes impossible to render.
    programme.derived.health.verdicts[0].stale = true;
    lifted.index([programme]);
    const stalePill = lifted.pill(programme, 7);
    if (
      stalePill.attrs["data-tip"] !== "Anchored failure." ||
      !/Stale/.test(stalePill.attrs["aria-label"]) ||
      /\bclosed\b/.test(stalePill.className)
    )
      die(
        "room-pill: stale evidence did not become a neutral stale pill with its reason",
      );

    // Structure, not the appearance of structure. The renderer emitted `div.md-h` and `div.md-li`,
    // which looked like nine headings and ten list items and exposed NONE of them: the accessibility
    // tree for a 111-line document held zero headings and zero lists, so a screen-reader reader got
    // one undifferentiated run of paragraphs with nothing to navigate by. Ordered lists were worse
    // than invisible — `1.` was not matched at all, so PRD.md §2, this product's own definition of
    // itself, was joined into a single run-on sentence on screen AND on paper.
    const { renderMarkdown } = lifted;
    const tags = (node) => {
      const out = [];
      (function walk(n) {
        for (const c of n.children || []) {
          if (c.tagName) out.push(c.tagName);
          walk(c);
        }
      })(node);
      return out;
    };
    const find = (node, tag) => {
      let hit = null;
      (function walk(n) {
        for (const c of n.children || []) {
          if (!hit && c.tagName === tag) hit = c;
          walk(c);
        }
      })(node);
      return hit;
    };
    const doc = renderMarkdown(
      "# Title\n\n## Section\n\nProse.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n",
    );
    const t = tags(doc);
    // Demoted by two: the reader panel is already an h2, so the document\'s `#` is an h3.
    if (t.indexOf("H3") < 0 || t.indexOf("H4") < 0)
      die("markdown: `#`/`##` did not become real headings — got " + t.join(","));
    // The old renderer emitted div.md-h and div.md-li. A DIV anywhere in the output means it is back.
    if (t.indexOf("DIV") > -1)
      die(
        "markdown: the renderer emitted a <div> — headings and list items are divs again, which look like structure and expose none",
      );
    if (!find(doc, "UL") || !find(doc, "OL"))
      die(
        "markdown: a bullet list and a numbered list must be <ul> and <ol> — got " +
          t.join(","),
      );
    if (find(doc, "UL").children.filter((c) => c.tagName === "LI").length !== 2)
      die("markdown: a two-item bullet list did not produce two <li>");
    const ol = find(doc, "OL");
    if (ol.children.filter((c) => c.tagName === "LI").length !== 2)
      die(
        "markdown: `1.`/`2.` did not produce two <li> — numbered lists are being joined into a paragraph",
      );
    // Structure AND content. Every one of these assertions passed while every list item on screen was
    // empty: the renderer took the wrong capture group — the indent for a bullet, the number for an
    // ordered item — so 104 items across forma's own canon rendered as blank <li> or a bare digit, in
    // the lens whose entire payload is that canon. Counting the <li> proves a list exists; reading it
    // proves the list says something.
    const liText = (node) =>
      node.children
        .filter((c) => c.tagName === "LI")
        .map((li) => String(li.text || li.textContent || "") + (li.children || []).map(textOf).join(""));
    if (JSON.stringify(liText(find(doc, "UL"))) !== JSON.stringify(["one", "two"]))
      die("markdown: bullet items rendered without their text — got " + JSON.stringify(liText(find(doc, "UL"))));
    if (JSON.stringify(liText(ol)) !== JSON.stringify(["first", "second"]))
      die("markdown: numbered items rendered without their text — got " + JSON.stringify(liText(ol)));
    if (!find(doc, "BLOCKQUOTE"))
      die("markdown: `>` did not become a <blockquote>");
    // A list that starts at 3 renders as 3, 4 — silently renumbering somebody else\'s document is a
    // lie about what it says.
    const off = renderMarkdown("3. third\n4. fourth\n");
    if (find(off, "OL").attrs.start !== "3")
      die("markdown: a list starting at 3 was silently renumbered from 1");
    // ...but a paragraph opening with a year is prose, not the two-thousand-and-twenty-sixth item.
    if (find(renderMarkdown("2026. The year the manifest was frozen.\n"), "OL"))
      die("markdown: a sentence beginning with a year was turned into a list");
    // Once a list IS running, a four-digit item is an item. Dropping it into the paragraph buffer is
    // a silent structural loss (I9), which is worse than rendering it plainly.
    if (
      find(
        renderMarkdown("10. ten\n100. hundred\n1000. thousand\n"),
        "OL",
      ).children.filter((c) => c.tagName === "LI").length !== 3
    ) {
      die("markdown: an item numbered past 999 was dropped out of its own list");
    }
    // Nested lists (Audit #13): a deeper indent is a list under the previous item, not a flat row.
    // The renderer ingests arbitrary client documents, so a nested list that flattens is a structural
    // lie about what the document says — and the corpus has none today, which is exactly when it rots.
    const nested = renderMarkdown(
      "- parent\n  - child one\n  - child two\n- sibling\n",
    );
    const ul = find(nested, "UL");
    if (!ul) die("markdown: a bullet list did not produce a <ul>");
    const lis = ul.children.filter((c) => c.tagName === "LI");
    if (lis.length !== 2)
      die(
        `markdown: nested list flattened — expected 2 top-level <li>, got ${lis.length}`,
      );
    const childUl = lis[0].children.filter((c) => c.tagName === "UL");
    if (childUl.length !== 1)
      die(
        "markdown: a deeper indent did not become a nested <ul> under its parent item",
      );
    if (childUl[0].children.filter((c) => c.tagName === "LI").length !== 2)
      die("markdown: the nested list lost its items");
    // cross-type nesting: an ordered list under a bullet item
    const mixed = renderMarkdown("- parent\n  1. first\n  2. second\n");
    const muls = find(mixed, "UL");
    if (
      !muls ||
      !muls.children
        .filter((c) => c.tagName === "LI")[0]
        .children.some((c) => c.tagName === "OL")
    ) {
      die("markdown: an ordered list under a bullet item was not nested");
    }
    // a lone CR, U+2028 or U+2029 inside a document HUNG THE BROWSER: `.` and `$` exclude all three
    // in JavaScript, so the unanchored list detector matched a line the anchored consumer could not,
    // the index never advanced, and the loop appended empty <ul>s until the heap died. Repository
    // text reaches this renderer unfiltered, so it was a hang triggered by somebody else's bytes.
    // These cases run in-process: a regression hangs the suite, which is the honest failure — a test
    // for a non-terminating loop cannot both prove termination and return.
    for (const [why, input, want] of [
      ["a lone CR inside a bullet", "- item\rmore\n", "UL"],
      ["a lone CR inside a numbered item", "1. item\rmore\n", "OL"],
      ["U+2028 inside a bullet", "- item\u2028more\n", "UL"],
      ["U+2029 inside a bullet", "- item\u2029more\n", "UL"],
    ]) {
      if (!find(renderMarkdown(input), want))
        die(
          `markdown: ${why} did not produce a <${want.toLowerCase()}> — the line terminator was not normalised`,
        );
    }
    // Same mismatch, silent instead of fatal: the heading was rendered as a paragraph, hash included.
    if (!find(renderMarkdown("# Title\u2028more\n"), "H3"))
      die(
        "markdown: a heading followed by U+2028 rendered as a paragraph with its hash still in it",
      );
    console.log(
      "  ok markdown — a document cannot inject a scheme through a link, a refused link is shown rather than dropped, and headings, bullet lists, numbered lists and quotes are real elements",
    );
  });

  // Locale parity, now that the tables are files rather than a literal buried in the template. I15
  // claimed this was enforced for the Control Room; it was only ever true of the single-lens viewer.
  test("briefing: strings", async () => {
    const en = readJson(join(HERE, "..", "lib/viewer/strings/en.json"));
    const it = readJson(join(HERE, "..", "lib/viewer/strings/it.json"));
    const missing = Object.keys(en).filter(function (k) {
      return !(k in it);
    });
    const extra = Object.keys(it).filter(function (k) {
      return !(k in en);
    });
    if (missing.length)
      die(
        "strings: keys present in en and missing from it: " + missing.join(", "),
      );
    if (extra.length)
      die("strings: keys present in it and missing from en: " + extra.join(", "));
    // A key the template never reads is dead weight a translator still has to carry.
    const template = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    // Word-boundary, not substring: `STR.drift` "reads" inside `STR.driftNoMilestone`, so a key that
    // became dead was reported alive by a key added in the same change. Any short key that prefixes a
    // longer one was invisible to this check.
    const unused = Object.keys(en).filter(function (k) {
      return !new RegExp("STR\\." + k + "\\b").test(template);
    });
    if (unused.length)
      die(
        "strings: declared but never read by the template: " + unused.join(", "),
      );
    // A string carrying a {placeholder} has to reach the reader through fmt(). Appending one raw puts
    // a literal `{closed}` on the page — which is what shipped for the length of one screenshot, in
    // the sentence written to stop the first screen reading as broken.
    const raw = Object.keys(en).filter(function (k) {
      if (!/\{[a-zA-Z]\w*\}/.test(en[k])) return false;
      return !new RegExp("(?:fmt|plural)\\([^)]*STR\\." + k + "\\b").test(
        template,
      );
    });
    if (raw.length)
      die(
        "strings: carries a {placeholder} but never reaches fmt(), so it renders literally: " +
          raw.join(", "),
      );
    console.log(
      `  ok strings — ${Object.keys(en).length} keys at en/it parity, every one read by the template`,
    );
  });

  // Queue and Kanban are supporting technical evidence, not two undocumented top-level products.
  // They stay complete through lazy, bounded disclosure inside the plan lens; every address the
  // five-view IA published stays a valid one.
  test("briefing: room-workflow", async () => {
    const template = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    const viewerFn = (name) =>
      (new RegExp("function " + name + "\\([^]*?\\n}\\n").exec(template) ||
        [])[0] || "";
    // The viewer holds no literal list of routes any more: BUILD names one builder per lens and the
    // order, labels and questions arrive injected. A hard-coded array here would just restate the
    // table a third time, which is the drift lib/lenses.mjs exists to end — so what is checked is
    // that every declared lens has a builder and nothing else does.
    const buildSource = (/var BUILD=\{([^}]*)\}/.exec(template) || [])[1] || "";
    const built = [...buildSource.matchAll(/(\w+):view/g)].map((m) => m[1]);
    const routes = LENSES.map((l) => l.id).filter((id) => id !== "portfolio");
    if (built.join() !== routes.join())
      die("room-ia: BUILD does not mount exactly the declared lenses: " + built);
    if (!/var LENS_SPEC=\(window\.__LENSES__\|\|\[\]\)/.test(template))
      die("room-ia: the viewer restates its own route table instead of reading the injected one");
    for (const [from, to] of Object.entries({ exec: "verdict", tech: "plan", map: "architecture", wbs: "traceability", docs: "provenance", auto: "plan", kanban: "plan" }))
      if (!new RegExp(from + ':"' + to + '"').test(template))
        die(`room-ia: the retired /${from} address no longer redirects to ${to}`);
    if (
      !/function workflow\(/.test(template) ||
      !/d\.open&&!d\.getAttribute\("data-filled"\)/.test(template)
    )
      die("room-tech: supporting workflows are not lazy");
    const pageSize = Number(
      (/var ISSUE_PAGE_SIZE=(\d+)/.exec(template) || [])[1],
    );
    if (
      !(pageSize > 0 && pageSize <= 40) ||
      !/function pagedList\(/.test(template)
    )
      die("room-dom: issue rendering has no bounded pager");
    for (const fn of ["renderQueue", "renderKanban"]) {
      const body = viewerFn(fn);
      if (!(fn === "renderQueue" ? /filteredList\(/ : /pagedList\(/).test(body))
        die("room-dom: " + fn + " bypasses the bounded pager");
    }
    const filter = viewerFn("filteredList"),
      queue = viewerFn("renderQueue"),
      kanban = viewerFn("renderKanban"),
      item = viewerFn("queueItem");
    if (
      !/item\.search/.test(filter) ||
      !/input\.addEventListener\("input",draw\)/.test(filter)
    )
      die(
        "room-search: the bounded shared list filter no longer searches on input",
      );
    // One block renderer for the archive and for every panel that shows a block: the auto/manual
    // command boundary lives in exactly one place.
    if (
      !/filteredList\(lane\.body,items/.test(queue) ||
      !/queueItem\(program,entry\.block\)/.test(queue) ||
      !/block\.auto&&block\.cmd\?commandLine\(block\.cmd\):el\("span","state-chip",STR\.human\)/.test(
        item,
      )
    )
      die(
        "room-queue: blocks lost search or the exact auto/manual command boundary",
      );
    // The brief's own words about a batch ride on the block, and are rendered as claims — anchor,
    // staleness and refusal path intact — not retyped as prose.
    if (
      !/notes=block\.notes\|\|\[\]/.test(item) ||
      !/STR\.blockWhy/.test(item) ||
      !/briefClaimRow\(program,notes\[j\]\)/.test(item)
    )
      die("room-queue: the block narrative from the brief is not rendered on the block");
    if (
      !/input\.type="search"/.test(kanban) ||
      !/source\.filter/.test(kanban) ||
      !/names\.concat\(\[\["chiuse"/.test(kanban)
    )
      die("room-kanban: search or the CLOSED archive lane is missing");
    const makeKanban = new Function(
      "el", "panel", "markState", "fmt", "STR", "pagedList", "short", "pill", "document",
      kanban + ";return renderKanban;",
    );
    const kanbanFixture = makeKanbanFixture();
    makeKanban(
      kanbanFixture.helpers.el,
      kanbanFixture.helpers.panel,
      kanbanFixture.helpers.markState,
      kanbanFixture.helpers.fmt,
      kanbanFixture.helpers.STR,
      kanbanFixture.helpers.pagedList,
      kanbanFixture.helpers.short,
      kanbanFixture.helpers.pill,
      kanbanFixture.helpers.document,
    )(kanbanFixture.target, kanbanFixture.program);
    kanbanFixture.flush();
    const assertKanbanPage = (key, expectedRows) => {
      const lanes = kanbanFixture.lanes(), active = lanes.filter((d) => d.open);
      const pages = kanbanFixture.pages();
      if (active.length !== 1 || active[0].key !== key || pages.length !== (expectedRows ? 1 : 0))
        die("room-kanban: lane switch must retain exactly one selected lane and page (expected " + key + ", active " + active.map((d) => d.key).join(",") + ", states " + lanes.map((d) => d.key + ":" + d.open).join(",") + ", pages " + pages.length + ")");
      if (pages[0] && pages[0].children.length > 40)
        die("room-kanban: a lane mounted more than the 40-row issue page");
    };
    for (const lane of kanbanFixture.lanes()) {
      lane.open = true;
      lane.dispatch("toggle");
      kanbanFixture.flush();
      assertKanbanPage(lane.key, lane.rows.length);
    }
    const zeroLane = kanbanFixture.lanes().find((d) => d.key === "premessa-falsa");
    zeroLane.open = true;
    zeroLane.dispatch("toggle");
    kanbanFixture.flush();
    const kanbanInput = kanbanFixture.input();
    kanbanInput.value = "Stress issue 61";
    kanbanInput.dispatch("input");
    kanbanFixture.flush();
    assertKanbanPage("premessa-falsa", 0);
    const closedLane = kanbanFixture.lanes().find((d) => d.key === "chiuse");
    closedLane.open = true;
    closedLane.dispatch("toggle");
    kanbanFixture.flush();
    assertKanbanPage("chiuse", closedLane.rows.length);
    kanbanInput.value = "Stress issue";
    kanbanInput.dispatch("input");
    kanbanFixture.flush();
    assertKanbanPage("chiuse", closedLane.rows.length);
    const tech = viewerFn("viewPlan");
    if (
      !/names\[i\]\[0\]!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(
        tech,
      ) ||
      !/key!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(
        kanban,
      )
    )
      die(
        "room-kanban: an undeclared human-label rule is rendered as a measured empty bucket",
      );
    const milestones = viewerFn("milestonePanel"),
      plan = viewerFn("viewPlan");
    if (
      !/milestonesComplete/.test(milestones) ||
      !/complete\?"present":"unknown"/.test(milestones) ||
      !/STR\.milestoneIncomplete/.test(milestones)
    )
      die(
        "room-milestones: an issue-derived milestone panel does not disclose incomplete collection",
      );
    // The RESULT must reach the DOM, not merely the call. A nullable panel makes `foo(program)`
    // matchable while the append is gone, which is how a panel disappears with the test still green.
    if (!/var msPanel=milestonePanel\(program\);if\(msPanel\)ev\.appendChild\(msPanel\)/.test(plan))
      die(
        "room-milestones: milestone evidence is not nested under the plan lens, whose question it answers",
      );
    if (!/var cpPanel=criticalPathPanel\(program\);if\(cpPanel\)ev\.appendChild\(cpPanel\)/.test(plan))
      die("room-plan: the critical path is computed and not mounted");
    if (!/documentGatePanel\(program\)/.test(viewerFn("viewProvenance")))
      die(
        "room-docs: the document gate is not nested under the provenance lens",
      );
    const documentPanel = viewerFn("documentGatePanel");
    if (
      !/chips\(f\.matched\)/.test(documentPanel) ||
      !/gate\.claims\|\|\[\]/.test(documentPanel)
    )
      die(
        "room-docs: the document gate panel hides measured wiring or typed claims",
      );
    if (
      !/gate\.errors\.length/.test(documentPanel) ||
      !/gate\.errors\[i\]/.test(documentPanel)
    )
      die("room-docs: non-empty document gate input errors are not disclosed");
    if (
      !/id="mobile-program"/.test(template) ||
      !/id="mobile-view"/.test(template)
    )
      die("room-mobile: native route controls are absent");
    if (
      !/\.screen-list,\.workflow\{display:none!important\}/.test(template) ||
      /details:not\(\[open\]\)/.test(template)
    )
      die("room-print: interactive archives can expand into print");
    if (
      !/execHeadlineUnknown/.test(template) ||
      !/techHeadlineUnknown/.test(template) ||
      !/thesisUnknown/.test(template)
    )
      die("room-truth: unknown claims have no explicit headline path");
    // A viewport-locked shell turns "too tall" into "invisible", not "scrollable": an uncapped answer
    // tier took 868-967px on the verdict lens and left the evidence row at zero height with six
    // panels below an unscrollable fold. Measured at 1440x900, 1280x800 and 1920x1080.
    if (!/\.answer\{[^}]*max-height:\d+vh[^}]*overflow:auto/.test(template))
      die("room-layout: the answer tier is unbounded and can starve the evidence tier to zero height");
    if (!/\.pager button\{min-height:44px/.test(template))
      die("room-mobile: pager target is below 44px");
    if (!/\.skip\{[^}]*min-height:44px/.test(template))
      die("room-mobile: skip target is below 44px");
    if (
      !/\.prov\{overflow:visible;text-overflow:clip;white-space:normal/.test(
        template,
      )
    )
      die("room-mobile: provenance is truncated without a disclosure");
    const composer = readFileSync(join(HERE, "..", "lib/room.mjs"), "utf-8");
    if (!/theme: manifest\.theme \|\| 'light'/.test(composer))
      die("room-theme: a fresh client briefing does not default to light");
    // #120 AC5/density P2: `.queue-command` only ever exists inside the Queue workflow, which used
    // to sit collapsed and last in the plan lens's evidence tier — burying every command below the
    // fold at 1440. The queue is now the one workflow that opens (and fills) eagerly, and mounts
    // first in that tier, ahead of the blocked-issues panel.
    const viewPlan = viewerFn("viewPlan");
    if (
      !/workflow\(program,STR\.routeQueue,function\(target\)\{renderQueue\(target,program\);\},true\)/.test(
        viewPlan,
      )
    )
      die("room-density: the queue workflow no longer opens eagerly");
    const queueMount = viewPlan.indexOf("STR.routeQueue"),
      blockedMount = viewPlan.indexOf("STR.techBlocked");
    if (queueMount === -1 || blockedMount === -1 || queueMount > blockedMount)
      die(
        "room-density: the queue must mount ahead of the blocked panel to reach the first screen",
      );
    // #120 AC5 visual: `minmax(180px,auto)` never grew past its own floor for a flex panel with
    // `overflow:visible` content (confirmed empirically, not just read from the CSS) — every
    // `.evidence` row rendered at exactly 180px regardless of content, so a tall finding painted
    // over the panel below it rather than growing its own row. The row track uses plain
    // `max-content`, which this worktree confirmed grows correctly to each row's tallest panel.
    if (/\.evidence\{[^}]*grid-auto-rows:minmax\(180px,auto\)/.test(template))
      die("room-density: .evidence's row track floor is back on the broken minmax(fixed,auto) form");
    if (!/grid-auto-rows:max-content;align-content:start;align-items:start\}/.test(template))
      die("room-density: the evidence row track lost its content-based sizing");
    // #120 AC5 (second pass): a per-panel `min-height:180px` floor "fixed" the overlap above but
    // wasted ~150px on every near-empty text panel ("Waiting on a decision", one pill) — pushing the
    // panels after it past the fold. The floor belongs to the chart's own drawing area
    // (`.chart-viz`, which already carried it, `.chart{min-height:0}` resets the PANEL itself), not
    // to every evidence panel; a chart-viz floor cannot cause the row-track defect above (that was
    // the row track ignoring content height, not a panel being short) and `room-layout.mjs`'s
    // overlap/left-clip checks confirm this empty-handed.
    if (/\.evidence>\.panel\{min-height:\d+px\}/.test(template))
      die("room-density: the evidence panel floor is back — it starves the panels after a short one");
    if (!/\.chart-viz\{flex:1 1 auto;min-height:180px/.test(template))
      die("room-density: the chart's own drawing-area floor is gone");
    // A right-anchored SVG label grows LEFT from its anchor; a fixed 6.4px/char truncation budget
    // could still render wider than its own gutter and clip the leftmost glyph off-canvas (the
    // milestone chart's row names, confirmed at ~3px past the panel's own left edge). `nameLabel`
    // re-measures with `getComputedTextLength()` and keeps shrinking until it actually fits, and
    // discloses the untruncated name as a native tooltip once it has to.
    if (!/function nameLabel\(svg,x,y,full,maxWidth\)/.test(template))
      die("room-density: the milestone chart's row-name labels lost their fit-and-disclose guard");
    if (!/getComputedTextLength/.test(template))
      die("room-density: label truncation is not verified against its own rendered width");
    if (!/nameLabel\(svg,gutter-7,y\+3\.5,it\.name,gutter-4\)/.test(template))
      die("room-density: barsH row names no longer use the measured-fit label");
    // #120 AC5: a height cap on the queue panel was tried and reverted — capping it traded the
    // queue's own (honestly measured) visible pills for space that landed on the same 180px-per-panel
    // floor this pass removed, a net loss (see HANDOFF.md). Sizing the evidence tier to content
    // instead makes the cap unnecessary: the queue keeps `panel()`'s plain, uncapped call.
    if (/"cap-queue"/.test(template))
      die("room-density: a reverted queue-panel height cap is still referenced");
    console.log(
      "  ok room-workflow — lens routing from the injected table, searchable blocks/Kanban, honest milestones, bounded lazy evidence, mobile and print contracts",
    );
  });

  // One issue primitive keeps every view honest: colour only from validated health, the same anchored
  // why on hover, a word plus glyph, and closed work visibly closed. No plain issueLink may bypass it (#63).
  test("briefing: room-pill", async () => {
    const template = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    const pill = (template.match(/function pill\([^]*?\n}/) || [])[0];
    if (!pill) die("room-pill: the shared pill() primitive is missing");
    // The colour still comes from the derived, staleness-aware health overlay — but through the index
    // the verdict lens publishes, because a shared primitive reaching into a derived surface itself
    // gives that surface a home in every lens that draws a pill (I20).
    const indexer = (template.match(/function indexVerdicts\(\)\{[^]*?\n}\n/) || [])[0] || "";
    if (!/verdictMarkOf\(p,n\)/.test(pill) || /derived/.test(pill))
      die("room-pill: colour is not read from the verdict lens's published index");
    // The index must INTERPRET, not pass through: staleness beats the verdict here, once, so no
    // other lens can get that precedence wrong (I8).
    if (!/verdicts\[j\]\.stale\?"stale":verdicts\[j\]\.verdict/.test(indexer))
      die("room-pill: the verdict index hands on the raw overlay instead of the decided mark");
    if (
      !/program\.derived&&program\.derived\.health&&program\.derived\.health\.verdicts/.test(indexer)
    )
      die(
        "room-pill: colour is not sourced from the derived, staleness-aware health overlay",
      );
    if (!/data-tip/.test(pill))
      die("room-pill: the anchored why is not exposed on the issue reference");
    if (!/statusMark/.test(pill))
      die("room-pill: the verdict has no shared glyph + word encoding");
    if (!/state==="CLOSED"/.test(pill))
      die("room-pill: closed issues are not encoded");
    if (!/\.issue-pill \.issue-text\{[^}]*min-width:0/.test(template))
      die(
        "room-pill: long issue titles escape their pill on a narrow board lane",
      );
    if (!/mark\.lastChild\.textContent/.test(pill))
      die("room-pill: the accessible name omits the verdict word");
    if (/\bissueLink\(/.test(template))
      die("room-pill: a plain issue link bypasses pill()");
    console.log(
      "  ok room-pill — every issue reference shares current/stale/closed state, anchored reason, glyph and word",
    );
  });

  // The map already embeds Forma's full explorer. Keep one drill surface: prove the iframe carries the
  // explicit [+] control, stack navigation and C4 level breadcrumb, then pin the owner decision (#64).
  test("briefing: room-c4-drill", async () => {
    const room = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    const holo = readFileSync(
      join(HERE, "..", "lib/viewer/c4-hologram.html"),
      "utf-8",
    );
    const decisions = readFileSync(
      join(HERE, "..", "DECISION_REGISTRY.md"),
      "utf-8",
    );
    if (!/srcdoc=frameDoc\(program\)/.test(room))
      die("room-c4-drill: the map no longer embeds the hologram");
    if (!/data-drill="1"/.test(holo) || !/stack\.push\(id\)/.test(holo))
      die("room-c4-drill: the embedded hologram cannot drill into children");
    if (
      !/tabindex="0" focusable="true" role="button" aria-label=/.test(holo) ||
      !/stage\.addEventListener\("keydown"/.test(holo) ||
      !/ev\.key!=="Enter"&&ev\.key!==" "/.test(holo)
    )
      die("room-c4-drill: SVG nodes are not keyboard controls");
    if (!/class="detaildrill"/.test(holo) || !/drillTo\(n\.id,true\)/.test(holo))
      die("room-c4-drill: touch inspection has no 44px drill action");
    if (
      !/@media\(max-width:600px\)\{#stage\{overflow:auto/.test(holo) ||
      !/liveSvg\.style\.width=Math\.ceil\(vw\)/.test(holo)
    )
      die(
        "room-c4-drill: mobile still shrinks the entire map instead of panning at readable scale",
      );
    if (!/crumbLevel\+"-L"/.test(holo))
      die("room-c4-drill: the embedded hologram does not expose its C4 level");
    if (!/matchMedia\("\(max-width:600px\)"\)\.addEventListener\("change",function\(\)\{draw\(false\);\}\)/.test(holo))
      die("room-c4-drill: crossing the mobile breakpoint does not redraw readable map dimensions");
    if (!/\| D-07 \|[^\n]*embedded hologram[^\n]*sufficient/i.test(decisions))
      die("room-c4-drill: the delegated owner decision is not recorded");
    console.log(
      "  ok room-c4-drill — the embedded map is the ratified L1→L4 drill surface",
    );
  });

  // The public C4 viewer must keep a semantic twin for its visual map (#50). Browser acceptance
  // drives this actual iframe; this native contract keeps its table toggle, labelled SVG and required
  // columns from silently disappearing between browser runs.
  test("briefing: map-a11y", async () => {
    const holo = readFileSync(
      join(HERE, "..", "lib/viewer/c4-hologram.html"),
      "utf-8",
    );
    if (!/id="btable"/.test(holo) || !/id="maptable"/.test(holo))
      die("map-a11y: the rendered C4 map has no Show table control and target");
    if (!/<svg[^>]*role="group"[^>]*aria-label=/.test(holo))
      die("map-a11y: the rendered SVG root is not a descriptively named group");
    if (!/\$\("stage"\)\.hidden=show/.test(holo) || !/<th scope="col">/.test(holo))
      die("map-a11y: table mode does not replace the map or lacks column headers");
    for (const key of ["mapNodes", "mapRelationships", "node", "category", "status", "evidencePath", "from", "to", "relationship"])
      if (!new RegExp("\\b" + key + ":").test(holo))
        die("map-a11y: text equivalent omits its " + key + " column");
    console.log("  ok map-a11y — public map contract keeps its table columns and named SVG root");
  });
});
