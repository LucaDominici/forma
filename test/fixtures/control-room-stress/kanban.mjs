// A deliberately small DOM seam for the viewer's Kanban interaction contract. It
// proves lane disclosure and search behavior without a browser dependency.
export function makeKanbanFixture() {
  const pendingToggles = [];
  class Node {
    constructor(tag, className = "", text = "") {
      this.tagName = tag.toUpperCase();
      this.className = className;
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this._text = text;
      this.value = "";
      this._open = false;
    }
    appendChild(node) {
      this.children.push(node);
      return node;
    }
    set textContent(value) {
      this._text = value;
      this.children = [];
    }
    get textContent() {
      return this._text;
    }
    set open(value) {
      const next = Boolean(value);
      if (this._open !== next) pendingToggles.push(this);
      this._open = next;
    }
    get open() {
      return this._open;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    dispatch(type) {
      for (const fn of this.listeners[type] || []) fn.call(this, { type });
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }
  const el = (tag, className, text) => new Node(tag, className, text);
  const target = new Node("div");
  const document = { createElement: (tag) => new Node(tag) };
  const panel = () => {
    const node = new Node("section");
    node.body = new Node("div");
    node.appendChild(node.body);
    return node;
  };
  const issues = Array.from({ length: 120 }, (_, i) => ({
    n: i + 1,
    title: `Stress issue ${i + 1}`,
  }));
  const program = {
    issuesSnapshot: { issues },
    derived: {
      kanban: {
        "premessa-falsa": [1, 2],
        "aspettano-umano": [3],
        "a-meta": [4],
        sane: [5],
        "non-auditate": Array.from({ length: 55 }, (_, i) => i + 6),
        chiuse: Array.from({ length: 60 }, (_, i) => i + 61),
      },
      kanbanHumanDeclared: true,
    },
  };
  const helpers = {
    el,
    document,
    panel,
    markState: () => {},
    fmt: (s) => s,
    STR: {
      bucketPremessaFalsa: "Premessa falsa",
      bucketAspettanoUmano: "Aspettano umano",
      bucketAMeta: "A meta",
      bucketSane: "Sane",
      bucketNonAuditate: "Non auditate",
      bucketChiuse: "Chiuse",
      routeKanban: "Kanban",
      kanbanCount: "Issues",
      filterPlaceholder: "Filter",
      filterLabel: "Filter issues",
      statePresent: "present",
      stateEmpty: "empty",
      stateUnknown: "unknown",
      filterNone: "No matches",
      bucketHumanEmpty: "No human",
      bucketEmpty: "Empty",
      ruleUnknown: "Unknown",
    },
    pagedList: (target, rows, render) => {
      const page = new Node("div", "screen-list");
      for (const row of rows.slice(0, 40)) page.appendChild(render(row));
      target.appendChild(page);
    },
    short: (s) => s,
    pill: (_program, _n, text) => new Node("a", "pill", text),
  };
  const walk = (node, found = []) => {
    if (node) {
      found.push(node);
      for (const child of node.children) walk(child, found);
    }
    return found;
  };
  return {
    target,
    program,
    helpers,
    lanes: () => walk(target).filter((n) => n.className === "kanban-lane"),
    input: () => walk(target).find((n) => n.tagName === "INPUT"),
    pages: () => walk(target).filter((n) => n.className === "screen-list"),
    flush: () => {
      while (pendingToggles.length) pendingToggles.shift().dispatch("toggle");
    },
  };
}
