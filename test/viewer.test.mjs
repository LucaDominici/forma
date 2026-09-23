#!/usr/bin/env node
// The viewer HTML: hologram behavior, header/landmarks/focus/pan a11y, the explorer.
import test, { describe } from "node:test";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import {
  HERE,
  BIN,
  FIX,
  freshTmp,
  run,
  die,
  readJson,
  stripVolatile,
  diffPaths,
} from "./helpers.mjs";


const tmp = freshTmp();

describe("viewer", () => {
  test("viewer: viewer", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    // the label anchor must sit ON the curve: evaluate the shipped edgePath and compare against the
    // quadratic Bezier at t=0.5, recomputed from the control point in the path string it returned.
    const fn = (html.match(/\nfunction edgePath\(a,b\)\{[\s\S]*?\n\}/) || [])[0];
    if (!fn) die("viewer: edgePath not found — did the signature change?");
    const edgePath = new Function(fn + "; return edgePath")();
    for (const [a, b] of [
      [
        { x: 0, y: 0, w: 228, h: 118 },
        { x: 600, y: 400, w: 228, h: 118 },
      ],
      [
        { x: 500, y: 40, w: 228, h: 118 },
        { x: 60, y: 500, w: 228, h: 118 },
      ],
    ]) {
      const r = edgePath(a, b);
      const m = String(r.d).match(
        /^M([-\d.]+),([-\d.]+) Q([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/,
      );
      if (!m) die("viewer: unexpected edge path shape " + r.d);
      const [x1, y1, cx, cy, x2, y2] = m.slice(1).map(Number);
      const at = (p0, p1, p2) => 0.25 * p0 + 0.5 * p1 + 0.25 * p2; // Bezier at t=0.5
      if (
        Math.abs(r.mx - at(x1, cx, x2)) > 1e-9 ||
        Math.abs(r.my - at(y1, cy, y2)) > 1e-9
      ) {
        die(
          `viewer: label anchor (${r.mx},${r.my}) is off the curve (want ${at(x1, cx, x2)},${at(y1, cy, y2)})`,
        );
      }
      if (Math.abs(r.mx - cx) < 1e-9 && Math.abs(r.my - cy) < 1e-9)
        die("viewer: label anchored on the control point, not the curve");
    }
    // wrapDesc must never return a line wider than the box: an unbreakable token (long class name,
    // URL) would paint outside the rounded rect, and there is no clip-path on the node.
    const wfn = (html.match(
      /\nfunction wrapDesc\(desc,cpl,max\)\{[\s\S]*?\n\}/,
    ) || [])[0];
    if (!wfn) die("viewer: wrapDesc not found");
    const wrapDesc = new Function(wfn + "; return wrapDesc")();
    const cpl = 37;
    for (const [desc, max, why] of [
      [
        "Configures EmailNotificationDispatcherFactoryProvider.",
        3,
        "long token on a line that fits",
      ],
      ["a ".repeat(80), 2, "plain overflow"],
      ["short one", 3, "no truncation"],
      [
        "https://example.com/a/very/long/path/that/never/breaks/at/all",
        1,
        "unbreakable url",
      ],
    ]) {
      const out = wrapDesc(desc, cpl, max);
      if (out.length > max)
        die(`viewer wrapDesc: ${why} → ${out.length} lines, max ${max}`);
      for (const l of out)
        if (l.length > cpl)
          die(
            `viewer wrapDesc: ${why} → line of ${l.length} chars exceeds ${cpl}: ${JSON.stringify(l)}`,
          );
    }
    if (wrapDesc("anything at all", 37, 0).length)
      die("viewer wrapDesc: a box with no room must render no description");
    if (wrapDesc("short one", 37, 3).join("|") !== "short one")
      die("viewer wrapDesc: text that fits must not be altered");

    // a box that groups others borrows their verdicts — but the mean alone would be the invented
    // green (14 of 14 ruled done says nothing about the other 8), so the coverage is half the claim
    const rfn = (html.match(
      /\nfunction rollStatus\(node,kidsOf\)\{[\s\S]*?\n\}/,
    ) || [])[0];
    if (!rfn) die("viewer: rollStatus not found");
    const rollStatus = new Function(rfn + "; return rollStatus")();
    const tree = {
      dom: [
        { id: "a", status2: "done", completion: 100 },
        { id: "b", status2: "done", completion: 100 },
        { id: "c", status2: "unknown" },
      ],
    };
    const kidsOf = (id) => tree[id] || [];
    const r = rollStatus({ id: "dom" }, kidsOf);
    if (!r || r.mean !== 100 || r.ruled !== 2 || r.total !== 3)
      die(
        "rollStatus: a grouping box must report its children's mean AND how many were ruled, got " +
          JSON.stringify(r),
      );
    // worst-of, and `unknown` outranks `done` on purpose (the same rank the catalogue collapse uses):
    // a domain holding one package nobody ruled on is not a green domain, however green the rest is
    if (r.status2 !== "unknown")
      die(
        "rollStatus: an unruled child was averaged away into green, got " +
          r.status2,
      );
    const twoDone = (id) => (id === "dom" ? tree.dom.slice(0, 2) : []);
    if (rollStatus({ id: "dom" }, twoDone).status2 !== "done")
      die("rollStatus: all children ruled done must give done");
    // worst-of wins, so one broken child cannot hide behind two green ones
    tree.dom[2] = { id: "c", status2: "problem", completion: 10 };
    if (rollStatus({ id: "dom" }, kidsOf).status2 !== "problem")
      die("rollStatus: a problem child was averaged away");
    // a box that speaks for itself is left alone, and a box with nothing ruled below it stays silent
    if (rollStatus({ id: "dom", completion: 40 }, kidsOf))
      die("rollStatus: overrode a box that carries its own verdict");
    if (rollStatus({ id: "x" }, () => []))
      die("rollStatus: invented a roll-up for a box with no children");
    if (rollStatus({ id: "dom" }, () => [{ id: "q", status2: "unknown" }]))
      die("rollStatus: reported a mean where nobody ruled on anything");
    // …and a VERDICT is not a percentage. A document declares; it does not measure, so its nodes
    // carry `done` with no completion. Keying the roll-up on the number alone put `?` on a domain
    // holding nine packages a document calls finished — the same silence #42 closed, one cause later.
    const declared = (id) =>
      id === "dom"
        ? [
            { id: "a", status2: "done" },
            { id: "b", status2: "done" },
            { id: "c", status2: "unknown" },
          ]
        : [];
    const rd = rollStatus({ id: "dom" }, declared);
    if (!rd)
      die(
        "rollStatus: a box whose children are ruled WITHOUT a percentage went silent",
      );
    if (rd.ruled !== 2 || rd.total !== 3)
      die(
        "rollStatus: ruled/total must count verdicts, not percentages — got " +
          JSON.stringify(rd),
      );
    if (rd.mean != null)
      die(
        "rollStatus: invented a mean where no child carries one — got " + rd.mean,
      );

    // The badge is the first number a stakeholder reads, so it is a function like the rest.
    const bfn = (html.match(/\nfunction badgeOf\(n,roll\)\{[\s\S]*?\n\}/) ||
      [])[0];
    if (!bfn)
      die(
        "viewer: badgeOf not found — the badge must be liftable to be measurable",
      );
    const badgeOf = new Function(
      'var STR={stUnk:"?"};' + bfn + "; return badgeOf",
    )();
    const decl = {
      status2: "done",
      verify: { source: "FEATURES.md (2/2 declared done)", derived: true },
    };
    if (badgeOf({ status2: "unknown" }, null) !== "?")
      die('viewer badge: a box nobody ruled on must still read "?"');
    if (badgeOf(decl, null) === "?")
      die(
        'viewer badge: a box declared done read "?" — the badge contradicts its own colour',
      );
    if (/%/.test(badgeOf(decl, null)))
      die(
        "viewer badge: a declaration was printed as a percentage — " +
          badgeOf(decl, null),
      );
    if (
      badgeOf({ status2: "unknown" }, { mean: null, ruled: 9, total: 14 }) !==
      "9/14"
    )
      die(
        "viewer badge: a roll-up with no percentage must still report its coverage, got " +
          JSON.stringify(
            badgeOf({ status2: "unknown" }, { mean: null, ruled: 9, total: 14 }),
          ),
      );
    if (
      badgeOf({ status2: "done" }, { mean: 100, ruled: 9, total: 14 }) !==
      "100% 9/14"
    )
      die("viewer badge: the mean lost its coverage");
    if (
      badgeOf({ completion: 40, statusWord: "v2 in corso" }, null) !==
      "v2 in corso"
    )
      die("viewer badge: a curated word must still own the badge");
    if (badgeOf({ status2: "in-progress", completion: 40 }, null) !== "40%")
      die("viewer badge: a real measurement must still print");

    // "nobody ruled on it" must stop wearing the clothes of "not built yet": legHint teaches the
    // reader that a dashed box is `da costruire`, and .s-unk was dashed. That is complaint 2.
    const unkCss = (html.match(/\n\.s-unk rect\{[^}]*\}/) || [])[0];
    if (!unkCss) die("viewer: the .s-unk rect rule moved");
    if (/stroke-dasharray/.test(unkCss))
      die(
        'viewer: unknown is drawn with the dash the legend defines as "to build" — ' +
          unkCss.trim(),
      );
    if (
      !/stroke-dasharray/.test(
        (html.match(/\n\.s-plan rect\{[^}]*\}/) || [""])[0],
      )
    )
      die("viewer: planned lost the dash that makes legHint true");
    // the legend has promised a HOLLOW green for a done nobody proved since #38; the canvas never drew one
    if (!/\.s-done\.decl rect\{/.test(html))
      die(
        'viewer: the legend promises "DONE (declared)" but no .s-done.decl rule draws it',
      );
    const clsLine = (html.match(/\n *var isCat=[^\n]*cls="nd s-"[^\n]*/) ||
      [])[0];
    if (!clsLine) die("viewer: the class-assembly line moved");
    if (!/decl/.test(clsLine))
      die(
        "viewer: a done DERIVED from a document is painted exactly like a proven one — " +
          clsLine.trim(),
      );

    // a derived number must disclose how much of the module its citation reaches — "3 of 3 rows
    // declared done" and "this module is done" are different sentences when the module holds 22 files
    const cfn = (html.match(/\nfunction coverText\(n\)\{[\s\S]*?\n\}/) || [])[0];
    if (!cfn) die("viewer: coverText not found");
    const coverText = new Function(
      'var STR={coverWhole:"WHOLE",coverPart:"{n}/{t}"};' +
        cfn +
        "; return coverText",
    )();
    if (coverText({ verify: { coverage: { named: 3, total: 22 } } }) !== "3/22")
      die("viewer coverage: a partially-covered box must report its reach");
    if (
      coverText({ verify: { coverage: { named: 8, total: 8, whole: true } } }) !==
      "WHOLE"
    )
      die(
        "viewer coverage: a whole-module row must say so, not print a fraction",
      );
    for (const n of [{}, { verify: {} }, { verify: { source: "ADR-040" } }]) {
      if (coverText(n))
        die(
          "viewer coverage: a curated or gh-verified state has no document reach to report: " +
            JSON.stringify(n),
        );
    }

    // a description that only restates the title is ink, not information — but a real sentence that
    // happens to contain the name must survive, or the box goes blank on its best content
    const efn = (html.match(/\nvar DESC_NOISE=[\s\S]*?\n\}/) || [])[0];
    if (!efn) die("viewer: echoesName not found");
    const echoesName = new Function(efn + "; return echoesName")();
    for (const [d, n] of [
      ["1 file: advisor.", "internal/advisor"],
      ["3 packages: a, b, c.", "a b c"],
      ["Component of module haben.", "haben"],
    ]) {
      if (!echoesName(d, n))
        die(`viewer echoesName: "${d}" restates "${n}" and should be dropped`);
    }
    for (const [d, n] of [
      ["Account domain: bank/broker kinds, free-cash, IBAN.", "internal/account"],
      ["Derives progress from the feature matrix.", "docmap"],
      ["", "x"],
    ]) {
      if (echoesName(d, n))
        die(`viewer echoesName: dropped real prose "${d}" for node "${n}"`);
    }

    // the headline percentage must never claim more coverage than it has. This is the flagship
    // promise ("mai un 100% inventato") and it lives in the one number read first.
    const tfn = (html.match(/\nfunction tallyOf\(kids,kidsOf\)\{[\s\S]*?\n\}/) ||
      [])[0];
    if (!tfn) die("viewer: tallyOf not found — did the tally move back inline?");
    const tallyOf = new Function(
      'var STMAP={done:"done","in-progress":"prog",next:"next",planned:"plan",problem:"prob",unknown:"unk"};' +
        tfn +
        "; return tallyOf",
    )();
    const flat = () => []; // a board of childless boxes: every kid IS its own unit
    // the shape that produced "progress 100%" on a board where half the containers had no verdict
    const half = [...Array(25)]
      .map((_, i) => ({ id: "d" + i, status2: "done", completion: 100 }))
      .concat(
        [...Array(28)].map((_, i) => ({ id: "u" + i, status2: "unknown" })),
      );
    const t = tallyOf(half, flat);
    if (t.mean !== 100)
      die(
        "viewer tally: the mean over the ruled nodes should stay 100, got " +
          t.mean,
      );
    if (t.ruled !== 25 || t.tot !== 53)
      die(`viewer tally: coverage should be 25/53, got ${t.ruled}/${t.tot}`);
    if (t.ruled === t.tot)
      die("viewer tally: a partially-ruled board must not report full coverage");
    // a node with no verdict is not 0% done — the mean must not be dragged toward zero either
    if (
      tallyOf(
        [{ status2: "done", completion: 100 }, { status2: "unknown" }],
        flat,
      ).mean !== 100
    )
      die("viewer tally: an unruled node was counted as 0%");
    // nothing ruled at all ⇒ no percentage to print
    if (
      tallyOf([{ status2: "unknown" }, { status2: "unknown" }], flat).mean !==
      null
    )
      die("viewer tally: a board nobody ruled on must print no percentage");
    // …and grouping those same 53 under 6 domain boxes must not change one digit of that line: the
    // domains are drawn, the packages are counted. Anything else means curating the wall away
    // silently deletes verdicts, which is how `2/7` came to stand for 25/53.
    const domains = [...Array(6)].map((_, i) => ({ id: "dom" + i }));
    const grouped = tallyOf(domains, (id) =>
      half.filter((_, i) => "dom" + (i % 6) === id),
    );
    if (
      !(
        grouped.ruled === t.ruled &&
        grouped.tot === t.tot &&
        grouped.mean === t.mean
      )
    ) {
      die(
        `viewer tally: grouping changed the board — flat ${t.ruled}/${t.tot} @${t.mean}% became ${grouped.ruled}/${grouped.tot} @${grouped.mean}%`,
      );
    }
    // …and the mirror mistake: descending into children NOBODY ruled on invents grey where a human
    // wrote an answer. This repo's own board is exactly that shape — a verdict per container, none on
    // the files inside — and descending unconditionally took it from `4/4 100%` to `0/19`, no
    // percentage at all. A box speaks for itself when the finer answer does not exist.
    const box = { id: "lib", status2: "done", completion: 100 };
    const files = [...Array(13)].map((_, i) => ({
      id: "f" + i,
      status2: "unknown",
    }));
    const kept = tallyOf([box], (id) => (id === "lib" ? files : []));
    if (!(kept.ruled === 1 && kept.tot === 1 && kept.mean === 100)) {
      die(
        `viewer tally: a curated verdict was discarded for ${files.length} children nobody ruled on — got ${kept.ruled}/${kept.tot} @${kept.mean}%`,
      );
    }
    // but one ruled child IS a finer answer, and then the children are what the box stands for
    const oneRuled = files
      .slice(0, 12)
      .concat([{ id: "f12", status2: "done", completion: 100 }]);
    const dropped = tallyOf([box], (id) => (id === "lib" ? oneRuled : []));
    if (!(dropped.ruled === 1 && dropped.tot === 13))
      die(
        `viewer tally: a ruled child did not outrank the box's own verdict — got ${dropped.ruled}/${dropped.tot}`,
      );
    // and the third mistake, the worst of the three: when NOBODY has ruled — not the box, not one
    // child — the box may not stand in for its subtree. Nine unknowns collapsing to one unknown
    // shrinks the denominator, and 25/53 would print as 25/45: coverage reading better than it is.
    const silent = tallyOf([{ id: "dom", status2: "unknown" }], (id) =>
      id === "dom" ? files.slice(0, 9) : [],
    );
    if (silent.tot !== 9)
      die(
        `viewer tally: ${silent.tot} unit(s) for 9 packages nobody ruled on — the denominator shrank, so the coverage reads better than it is`,
      );

    // every UI string must exist in BOTH locales (repo rule: en is default, it must keep up)
    const lit = (html.match(/\nvar STRINGS=\{[\s\S]*?\n\};/) || [])[0];
    if (!lit) die("viewer: STRINGS literal not found");
    const S = new Function(lit.replace(/;$/, "") + "; return STRINGS")();
    const missing = Object.keys(S.en).filter((k) => !(k in S.it));
    if (missing.length)
      die("viewer i18n: keys missing from `it`: " + missing.join(", "));
    if (!/labels:/.test(lit))
      die("viewer i18n: the LABELS toggle string is not in STRINGS");
    console.log(
      `  ok viewer — edge label anchored on the curve; i18n parity (${Object.keys(S.en).length} keys, en/it)`,
    );
  });
  test("viewer: f5-header-table", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const versionSrc = (
      html.match(/\nfunction systemVersion\(model\)\{[\s\S]*?\n\}/) || []
    )[0];
    if (!versionSrc) die("F5: systemVersion(model) was not found in the viewer");
    const systemVersion = new Function(versionSrc + "; return systemVersion")();
    if (systemVersion({ nodes: [{ kind: "system", statusWord: "v1.2.0" }] }) !== "v1.2.0")
      die("F5: systemVersion did not read a curated system node's statusWord");
    if (systemVersion({ nodes: [{ kind: "person", statusWord: "v1.2.0" }] }) !== null)
      die("F5: systemVersion must not borrow a version from a non-system node");
    if (systemVersion({ nodes: [] }) !== null)
      die("F5: systemVersion must stay silent rather than invent a version");
    if (!/STR\.stampVersion/.test(html))
      die("F5: the fact-base stamp never reads the version string");

    // hasEvidenceCol calls evidencePath, so extract the file region spanning both definitions.
    const region = (html.match(/\nfunction evidencePath[\s\S]*?function hasEvidenceCol\(nodes\)\{[\s\S]*?\n\}/) || [])[0];
    if (!region) die("F5: hasEvidenceCol(nodes) was not found in the viewer");
    const built = new Function(
      'var STR={unknown:"Unknown"};' + region + "; return {evidencePath:evidencePath,hasEvidenceCol:hasEvidenceCol}",
    )();
    const noEvidence = [{ id: "forma" }, { id: "dev" }];
    const withEvidence = [{ id: "leaf", evidence: [{ type: "path", ref: "lib/x.mjs" }] }];
    if (built.hasEvidenceCol(noEvidence))
      die("F5: an all-Unknown evidence column must be hidden");
    if (!built.hasEvidenceCol(withEvidence))
      die("F5: a real evidence path must not be hidden");
    console.log(
      "  ok f5-header-table — the stamp surfaces a curated version and the map table drops an all-Unknown evidence column",
    );
  });
  test("viewer: f9-landmarks", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    if (!/<main id="content" tabindex="-1">/.test(html))
      die("F9: no `<main>` landmark around the explorer's content");
    if (!/<button class="skip" id="skip" type="button">/.test(html))
      die("F9: no skip-link button");
    if (!/skipBtn\.addEventListener\("click",function\(\)\{\$\("content"\)\.focus\(\);\}\)/.test(html))
      die("F9: the skip link does not move focus to the `<main>` landmark");
    console.log("  ok f9-landmarks — skip link moves focus into a `<main>` landmark");
  });
  test("viewer: f10-detail-focus", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    if (!/<div id="detail" tabindex="-1">/.test(html))
      die("F10: #detail is not a focus target (no tabindex)");
    const focusDetailSrc = (
      html.match(/\nfunction focusDetail\(\)\{[\s\S]*?\n\}/) || []
    )[0];
    if (!focusDetailSrc || !/scrollIntoView/.test(focusDetailSrc) || !/\.focus\(\)/.test(focusDetailSrc))
      die("F10: focusDetail() does not scroll the panel into view and focus it");
    const showDetailBody = (html.match(/\nfunction showDetail\(n\)\{[\s\S]*?\n\}\n/) || [])[0];
    const showRosterBody = (html.match(/\nfunction showRoster\(cat\)\{[\s\S]*?\n\}\n/) || [])[0];
    if (!showDetailBody || !/focusDetail\(\)/.test(showDetailBody))
      die("F10: showDetail() never calls focusDetail()");
    if (!showRosterBody || !/focusDetail\(\)/.test(showRosterBody))
      die("F10: showRoster() never calls focusDetail()");
    console.log("  ok f10-detail-focus — opening a node's detail scrolls it into view and focuses it");
  });
  test("viewer: f14-single-leaf", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const childrenOfSrc = (html.match(/\nfunction childrenOf\(pid\)\{[\s\S]*?\n\}/) || [])[0];
    const hasKidsSrc = (html.match(/\nfunction hasKids\(id\)\{[\s\S]*?\n\}/) || [])[0];
    const singleDeadEndSrc = (html.match(/\nfunction singleDeadEndChild\(id\)\{[\s\S]*?\n\}/) || [])[0];
    if (!childrenOfSrc || !hasKidsSrc || !singleDeadEndSrc)
      die("F14: childrenOf/hasKids/singleDeadEndChild were not all found in the viewer");
    const region = childrenOfSrc + "\n" + hasKidsSrc + "\n" + singleDeadEndSrc;
    const M = {
      nodes: [
        { id: "forma" },
        { id: "cli", parent: "forma" },
        { id: "cli-leaf", parent: "cli", level: "leaf" },
        { id: "lib", parent: "forma" },
        { id: "leaf1", parent: "lib", level: "leaf" },
        { id: "leaf2", parent: "lib", level: "leaf" },
        // Codex round 1: an empty CONTAINER is not a dead-end leaf — it may grow real children
        // later, and treating it as one would hide that it is still a container level.
        { id: "empty-pkg", parent: "forma" },
        { id: "empty-pkg-child", parent: "empty-pkg", level: "container" },
      ],
    };
    const withM = new Function(
      "M=arguments[0];" + region + "; return {singleDeadEndChild:singleDeadEndChild}",
    )(M);
    if (!withM.singleDeadEndChild("cli") || withM.singleDeadEndChild("cli").id !== "cli-leaf")
      die("F14: a container with one dead-end leaf child was not recognised");
    if (withM.singleDeadEndChild("lib"))
      die("F14: a container with two children must not be treated as a single dead end");
    if (withM.singleDeadEndChild("empty-pkg"))
      die("F14: a single NON-LEAF child (e.g. an empty container) must not be treated as a dead end");
    if (!/if\(only\)\{\$\("detail"\)\.style\.display="none";showDetail\(only\);return;\}/.test(html))
      die("F14: drillTo() does not open the single dead-end leaf's detail instead of navigating");
    console.log("  ok f14-single-leaf — a single dead-end leaf opens its detail instead of a one-box level");
  });
  test("viewer: f4-pan-hint", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    if (!/<div id="panhint" class="hint" hidden><\/div>/.test(html))
      die("F4: #panhint was not found (starts hidden)");
    if (!/ph\.hidden=st2\.scrollWidth<=st2\.clientWidth\+1/.test(html))
      die("F4: panhint visibility is not driven by actual horizontal overflow");
    const lit = (html.match(/\nvar STRINGS=\{[\s\S]*?\n\};/) || [])[0];
    const S = new Function(lit.replace(/;$/, "") + "; return STRINGS")();
    if (!S.en.panHint || !S.it.panHint)
      die("F4: panHint copy missing from one locale");
    console.log("  ok f4-pan-hint — mobile pan affordance follows real overflow, both locales carry copy");
  });
  test("viewer: codex-r1-explorer", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    // (1) resize-driven recompute, independent of draw()
    if (!/new ResizeObserver\(updatePanHint\)\.observe\(stage\)/.test(html))
      die("Codex#1: no ResizeObserver recomputes panhint on a #stage resize");
    if (!/function updatePanHint\(\)\{var st2=\$\("stage"\),ph=\$\("panhint"\);if\(st2&&ph\)ph\.hidden=st2\.scrollWidth<=st2\.clientWidth\+1;\}/.test(html))
      die("Codex#1: updatePanHint() was not extracted as its own reusable function");
    // (2) role="img" makes the aria-label on <span class="agg"> name-capable
    if (!/<span class="agg" role="img" aria-label="/.test(html))
      die('Codex#2: the tally span has an aria-label but no role that supports a name (axe: aria-prohibited-attr)');
    // (4) focus returns to the invoker on close
    const closeDetailSrc = (html.match(/\nfunction closeDetail\(\)\{[\s\S]*?\n\}/) || [])[0];
    if (!closeDetailSrc) die("Codex#4: closeDetail() was not found");
    if (!/lastInvoker\.focus\(\)/.test(closeDetailSrc))
      die("Codex#4: closeDetail() does not restore focus to the invoking element");
    if (!/dc\.addEventListener\("click",closeDetail\)/.test(html))
      die("Codex#4: the [x] close button in showDetail/showRoster is not wired to closeDetail");
    const showDetailBody2 = (html.match(/\nfunction showDetail\(n\)\{[\s\S]*?\n\}\n/) || [])[0];
    const showRosterBody2 = (html.match(/\nfunction showRoster\(cat\)\{[\s\S]*?\n\}\n/) || [])[0];
    if (!showDetailBody2 || !/lastInvoker=document\.activeElement/.test(showDetailBody2))
      die("Codex#4: showDetail() never records the invoking element before opening");
    if (!showRosterBody2 || !/lastInvoker=document\.activeElement/.test(showRosterBody2))
      die("Codex#4: showRoster() never records the invoking element before opening");
    // (5) reduced motion => instant scroll
    const focusDetailSrc2 = (html.match(/\nfunction focusDetail\(\)\{[\s\S]*?\n\}/) || [])[0];
    if (!focusDetailSrc2 || !/reducedMotion\(\)\?"auto":"smooth"/.test(focusDetailSrc2))
      die("Codex#5: focusDetail() always scrolls smoothly, ignoring prefers-reduced-motion");
    const reducedMotionSrc = (html.match(/\nfunction reducedMotion\(\)\{[\s\S]*?\n\}/) || [])[0];
    if (!reducedMotionSrc || !/prefers-reduced-motion:\s*reduce/.test(reducedMotionSrc))
      die("Codex#5: reducedMotion() does not query prefers-reduced-motion");
    console.log("  ok codex-r1-explorer — panhint tracks resize, tally role supports its name, close restores focus, reduced motion is honoured");
  });
  test("viewer: viewer-cap", async () => {
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const lift = (name) => {
      const m = html.match(
        new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}", "m"),
      );
      if (!m) die("viewer: " + name + " not liftable — it must be measurable");
      return m[0];
    };
    const STR = { stUnk: "?" };
    const STMAP = {
      done: "done",
      "in-progress": "wip",
      planned: "plan",
      next: "next",
      problem: "prob",
    };
    const fn = new Function(
      "STR",
      "STMAP",
      lift("rollStatus") +
        "\n" +
        lift("badgeOf") +
        "\n" +
        lift("tallyOf") +
        "\nreturn {rollStatus:rollStatus,badgeOf:badgeOf,tallyOf:tallyOf}",
    )(STR, STMAP);

    // One child carries a number; twenty-four are ruled without one.
    const kids = [];
    kids.push({ id: "k0", status2: "done", completion: 100 });
    for (let i = 1; i < 25; i++) kids.push({ id: "k" + i, status2: "done" });
    for (let i = 25; i < 53; i++) kids.push({ id: "k" + i, status2: "unknown" });
    const parent = { id: "p" };
    const kidsOf = (id) => (id === "p" ? kids : []);

    const roll = fn.rollStatus(parent, kidsOf);
    if (roll && roll.mean != null && roll.ruled !== 1) {
      die(
        "viewer: the badge averages over " +
          1 +
          " child but claims coverage of " +
          roll.ruled +
          " — mean and coverage must share a denominator, got " +
          JSON.stringify(roll),
      );
    }
    const badge = fn.badgeOf(parent, roll);
    if (/^100% 25\//.test(badge))
      die(
        'viewer: the badge reads "' +
          badge +
          '" from a single measured child — the complaint, verbatim',
      );

    const tally = fn.tallyOf(kids, kidsOf);
    if (tally && tally.mean != null && tally.ruled !== 1) {
      die("viewer: tallyOf mixes denominators too — " + JSON.stringify(tally));
    }
    console.log(
      "  ok viewer — a mean and a coverage never share a badge unless they share a denominator",
    );
  });
});
